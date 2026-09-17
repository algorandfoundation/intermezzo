package main

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"sync"
	"testing"

	"github.com/algorand/falcon"
	"github.com/hashicorp/vault/sdk/logical"
)

// Shared with the TypeScript address tests; entropy 1..32 matches algokey's
// TestPQGenerateUsesMnemonicSizedEntropy (source recorded in the fixture).
func TestDeterministicKeyVector(t *testing.T) {
	raw, err := os.ReadFile("testdata/falcon1024.json")
	if err != nil {
		t.Fatal(err)
	}
	var vector struct{ Entropy, PublicKey string }
	if err := json.Unmarshal(raw, &vector); err != nil {
		t.Fatal(err)
	}
	entropy, err := hex.DecodeString(vector.Entropy)
	if err != nil {
		t.Fatal(err)
	}
	pk, _, err := deriveKey(entropy)
	if err != nil {
		t.Fatal(err)
	}
	if base64.StdEncoding.EncodeToString(pk[:]) != vector.PublicKey {
		t.Fatal("derived public key differs from the fixed vector")
	}
}

func testBackend(t *testing.T) (logical.Backend, logical.Storage) {
	t.Helper()
	config := logical.TestBackendConfig()
	config.StorageView = &logical.InmemStorage{}
	b, err := Factory(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	return b, config.StorageView
}

func request(t *testing.T, b logical.Backend, s logical.Storage, op logical.Operation, path string, body map[string]interface{}) *logical.Response {
	t.Helper()
	resp, err := b.HandleRequest(context.Background(), &logical.Request{
		Operation: op,
		Path:      path,
		Data:      body,
		Storage:   s,
	})
	if err != nil {
		t.Fatalf("%s %s: %v", op, path, err)
	}
	return resp
}

// A key must be readable by a backend instance that did not create it — the
// in-process equivalent of restarting Vault. Fails if anything a caller depends
// on is held in memory rather than written to storage.
func TestKeySurvivesNewBackend(t *testing.T) {
	b, s := testBackend(t)
	created := request(t, b, s, logical.UpdateOperation, "keys/alice", nil)

	reopened, err := Factory(context.Background(), &logical.BackendConfig{StorageView: s})
	if err != nil {
		t.Fatal(err)
	}
	read := request(t, reopened, s, logical.ReadOperation, "keys/alice", nil)
	if read.Data["public_key"] != created.Data["public_key"] {
		t.Fatalf("reopened backend returned %v, want %v", read.Data, created.Data)
	}

	// The stored private key must still sign for the stored public key.
	signed := request(t, reopened, s, logical.UpdateOperation, "sign/alice", map[string]interface{}{
		"input": base64.StdEncoding.EncodeToString([]byte("after restart")),
	})
	sig, _ := base64.StdEncoding.DecodeString(signed.Data["signature"].(string))
	pkBytes, _ := base64.StdEncoding.DecodeString(read.Data["public_key"].(string))
	pk := falcon.PublicKey{}
	copy(pk[:], pkBytes)
	if err := pk.Verify(falcon.CompressedSignature(sig), []byte("after restart")); err != nil {
		t.Fatalf("signature from reopened backend does not verify: %v", err)
	}
}

// Concurrent creates of one name must all report the public key that was
// actually stored.
// Run under -race to also catch unsynchronised access.
func TestConcurrentCreateIsConsistent(t *testing.T) {
	b, s := testBackend(t)

	const goroutines = 8
	publicKeys := make([]string, goroutines)
	var wg sync.WaitGroup
	for i := range publicKeys {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			resp, err := b.HandleRequest(context.Background(), &logical.Request{
				Operation: logical.UpdateOperation, Path: "keys/racy", Storage: s,
			})
			if err != nil {
				t.Error(err)
				return
			}
			publicKeys[i] = resp.Data["public_key"].(string)
		}(i)
	}
	wg.Wait()

	stored := request(t, b, s, logical.ReadOperation, "keys/racy", nil).Data["public_key"]
	for i, publicKey := range publicKeys {
		if publicKey != stored {
			t.Fatalf("goroutine %d got public key %s, but %s was stored", i, publicKey, stored)
		}
	}
}

func TestCreateReadSignFlow(t *testing.T) {
	b, s := testBackend(t)

	created := request(t, b, s, logical.UpdateOperation, "keys/alice", nil)
	if len(created.Data) != 1 {
		t.Fatalf("create returned %v, want only public_key", created.Data)
	}
	pkBytes, err := base64.StdEncoding.DecodeString(created.Data["public_key"].(string))
	if err != nil || len(pkBytes) != falcon.PublicKeySize {
		t.Fatalf("public_key decode err=%v len=%d want %d", err, len(pkBytes), falcon.PublicKeySize)
	}
	// Idempotent create and read both return the identical public key.
	again := request(t, b, s, logical.UpdateOperation, "keys/alice", nil)
	if again.Data["public_key"] != created.Data["public_key"] {
		t.Fatalf("second create changed public key: %v", again.Data)
	}
	read := request(t, b, s, logical.ReadOperation, "keys/alice", nil)
	if read.Data["public_key"] != created.Data["public_key"] {
		t.Fatalf("read mismatch: %v vs %v", read.Data, created.Data)
	}

	list := request(t, b, s, logical.ListOperation, "keys/", nil)
	if keys := list.Data["keys"].([]string); len(keys) != 1 || keys[0] != "alice" {
		t.Fatalf("list = %v", list.Data)
	}

	// Sign, then verify with the returned public key; wrong message must fail.
	msg := []byte("TX-test-message")
	signed := request(t, b, s, logical.UpdateOperation, "sign/alice", map[string]interface{}{
		"input": base64.StdEncoding.EncodeToString(msg),
	})
	sig, err := base64.StdEncoding.DecodeString(signed.Data["signature"].(string))
	if err != nil {
		t.Fatal(err)
	}
	pk := falcon.PublicKey{}
	copy(pk[:], pkBytes)
	if err := pk.Verify(falcon.CompressedSignature(sig), msg); err != nil {
		t.Fatalf("signature does not verify: %v", err)
	}
	if err := pk.Verify(falcon.CompressedSignature(sig), []byte("other")); err == nil {
		t.Fatal("signature verified against wrong message")
	}

	// Missing key read = 404 (nil), delete unsupported, bad sign inputs error.
	if resp := request(t, b, s, logical.ReadOperation, "keys/nobody", nil); resp != nil {
		t.Fatalf("read of missing key = %v, want nil", resp)
	}
	if _, err := b.HandleRequest(context.Background(), &logical.Request{
		Operation: logical.DeleteOperation, Path: "keys/alice", Storage: s,
	}); err == nil {
		t.Fatal("delete should be unsupported")
	}
	badSigns := []struct {
		path string
		body map[string]interface{}
	}{
		{"sign/alice", nil}, // missing input
		{"sign/alice", map[string]interface{}{"input": "not-base64!!"}}, // undecodable
		{"sign/nobody", map[string]interface{}{"input": "aGVsbG8="}},    // unknown key
	}
	for _, tc := range badSigns {
		resp, err := b.HandleRequest(context.Background(), &logical.Request{
			Operation: logical.UpdateOperation, Path: tc.path, Data: tc.body, Storage: s,
		})
		if err == nil && (resp == nil || !resp.IsError()) {
			t.Fatalf("%s with %v should error", tc.path, tc.body)
		}
	}
}
