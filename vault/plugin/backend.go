package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"sync"

	"github.com/algorand/falcon"
	"github.com/hashicorp/vault/sdk/framework"
	"github.com/hashicorp/vault/sdk/logical"
)

const backendHelp = `
The algorand-pq secrets engine manages Algorand post-quantum (Falcon-1024)
accounts. Keys never leave Vault; the API mirrors transit.
`

type keyEntry struct {
	// Entropy is the 32-byte root secret (the 25-word mnemonic). Salt and
	// PublicKey are spec-mandated persistent material; PrivateKey is
	// derivable from Entropy but cached because deriving it costs ~17ms
	// against ~4ms to sign.
	Entropy    []byte `json:"entropy"`
	Salt       byte   `json:"salt"`
	PublicKey  []byte `json:"public_key"`
	PrivateKey []byte `json:"private_key"`
}

type pqBackend struct {
	*framework.Backend
	// ponytail: one global create mutex; per-name locks if key creation ever needs throughput
	createMu sync.Mutex
}

// Factory is the plugin.ServeMultiplex entry point.
func Factory(ctx context.Context, conf *logical.BackendConfig) (logical.Backend, error) {
	b := &pqBackend{}
	b.Backend = &framework.Backend{
		Help:           backendHelp,
		BackendType:    logical.TypeLogical,
		RunningVersion: pluginVersion,
		Paths: []*framework.Path{
			{
				Pattern: "keys/?$",
				Operations: map[logical.Operation]framework.OperationHandler{
					logical.ListOperation: &framework.PathOperation{Callback: b.pathKeyList},
				},
				HelpSynopsis: "List Falcon-1024 keys.",
			},
			{
				Pattern: "keys/" + framework.GenericNameRegex("name"),
				Fields: map[string]*framework.FieldSchema{
					"name": {Type: framework.TypeString, Description: "Name of the key."},
				},
				Operations: map[logical.Operation]framework.OperationHandler{
					logical.UpdateOperation: &framework.PathOperation{Callback: b.pathKeyCreate},
					logical.ReadOperation:   &framework.PathOperation{Callback: b.pathKeyRead},
				},
				HelpSynopsis: "Create (idempotent) or read a Falcon-1024 key.",
			},
			{
				Pattern: "sign/" + framework.GenericNameRegex("name"),
				Fields: map[string]*framework.FieldSchema{
					"name":  {Type: framework.TypeString, Description: "Name of the key."},
					"input": {Type: framework.TypeString, Description: "Base64-encoded bytes to sign."},
				},
				Operations: map[logical.Operation]framework.OperationHandler{
					logical.UpdateOperation: &framework.PathOperation{Callback: b.pathSign},
				},
				HelpSynopsis: "Sign base64 input with a compressed Falcon-1024 signature.",
			},
		},
	}
	if err := b.Setup(ctx, conf); err != nil {
		return nil, err
	}
	return b, nil
}

func (b *pqBackend) getKey(ctx context.Context, s logical.Storage, name string) (*keyEntry, error) {
	raw, err := s.Get(ctx, "keys/"+name)
	if err != nil || raw == nil {
		return nil, err
	}
	entry := &keyEntry{}
	if err := raw.DecodeJSON(entry); err != nil {
		return nil, err
	}
	return entry, nil
}

func keyResponse(entry *keyEntry) *logical.Response {
	return &logical.Response{
		Data: map[string]interface{}{
			"scheme":     schemeFalcon1024,
			"salt":       int(entry.Salt),
			"public_key": base64.StdEncoding.EncodeToString(entry.PublicKey),
			"address":    encodeAddress(pqAddressDigest(entry.Salt, entry.PublicKey)),
		},
	}
}

func (b *pqBackend) pathKeyCreate(ctx context.Context, req *logical.Request, data *framework.FieldData) (*logical.Response, error) {
	name := data.Get("name").(string)

	b.createMu.Lock()
	defer b.createMu.Unlock()

	existing, err := b.getKey(ctx, req.Storage, name)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		return keyResponse(existing), nil
	}

	entropy := make([]byte, entropySize)
	if _, err := rand.Read(entropy); err != nil {
		return nil, err
	}
	pk, sk, err := deriveKey(entropy)
	if err != nil {
		return nil, err
	}
	salt, err := canonicalSalt(pk[:])
	if err != nil {
		return nil, err
	}

	entry := &keyEntry{
		Entropy:    entropy,
		Salt:       salt,
		PublicKey:  pk[:],
		PrivateKey: sk[:],
	}
	storageEntry, err := logical.StorageEntryJSON("keys/"+name, entry)
	if err != nil {
		return nil, err
	}
	if err := req.Storage.Put(ctx, storageEntry); err != nil {
		return nil, err
	}
	return keyResponse(entry), nil
}

func (b *pqBackend) pathKeyRead(ctx context.Context, req *logical.Request, data *framework.FieldData) (*logical.Response, error) {
	entry, err := b.getKey(ctx, req.Storage, data.Get("name").(string))
	if err != nil {
		return nil, err
	}
	if entry == nil {
		return nil, nil // 404, same as transit for a missing key
	}
	return keyResponse(entry), nil
}

func (b *pqBackend) pathKeyList(ctx context.Context, req *logical.Request, _ *framework.FieldData) (*logical.Response, error) {
	names, err := req.Storage.List(ctx, "keys/")
	if err != nil {
		return nil, err
	}
	return logical.ListResponse(names), nil
}

func (b *pqBackend) pathSign(ctx context.Context, req *logical.Request, data *framework.FieldData) (*logical.Response, error) {
	name := data.Get("name").(string)
	input := data.Get("input").(string)
	if input == "" {
		return logical.ErrorResponse("missing input to sign"), logical.ErrInvalidRequest
	}
	msg, err := base64.StdEncoding.DecodeString(input)
	if err != nil {
		return logical.ErrorResponse("input must be valid base64: %s", err), logical.ErrInvalidRequest
	}

	entry, err := b.getKey(ctx, req.Storage, name)
	if err != nil {
		return nil, err
	}
	if entry == nil {
		return logical.ErrorResponse("signing key not found: %s", name), logical.ErrInvalidRequest
	}
	if len(entry.PrivateKey) != falcon.PrivateKeySize {
		return nil, fmt.Errorf("stored private key for %q has size %d, want %d", name, len(entry.PrivateKey), falcon.PrivateKeySize)
	}

	sk := falcon.PrivateKey{}
	copy(sk[:], entry.PrivateKey)
	sig, err := sk.SignCompressed(msg)
	if err != nil {
		return nil, err
	}
	return &logical.Response{
		Data: map[string]interface{}{
			"signature": base64.StdEncoding.EncodeToString(sig),
		},
	}, nil
}
