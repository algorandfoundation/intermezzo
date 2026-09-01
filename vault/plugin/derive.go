package main

import (
	"crypto/sha512"
	"encoding/base32"
	"errors"

	"filippo.io/edwards25519"
	"github.com/algorand/falcon"
)

// Domain-separation constants mirrored from go-algorand: protocol/hash.go
// (PQK/PQA hash IDs), protocol/pq_scheme.go (2-byte ASCII scheme "f1" =
// Falcon-1024 deterministic profile). Verified against the algokey test
// vector in backend_test.go — do not change without new vectors.
const (
	hashIDPQKey      = "PQK"
	hashIDPQAddress  = "PQA"
	schemeFalcon1024 = "f1"

	entropySize = 32
)

var base32NoPad = base32.StdEncoding.WithPadding(base32.NoPadding)

// deriveKey deterministically derives a Falcon-1024 keypair from 32 bytes of
// mnemonic entropy: keygen seed = SHA512-256("PQK" || "f1" || entropy).
func deriveKey(entropy []byte) (falcon.PublicKey, falcon.PrivateKey, error) {
	if len(entropy) != entropySize {
		return falcon.PublicKey{}, falcon.PrivateKey{}, errors.New("entropy must be 32 bytes")
	}
	seed := sha512.Sum512_256([]byte(hashIDPQKey + schemeFalcon1024 + string(entropy)))
	return falcon.GenerateKey(seed[:])
}

// pqAddressDigest = SHA512-256("PQA" || "f1" || salt || pk).
func pqAddressDigest(salt byte, pk []byte) [32]byte {
	preimage := make([]byte, 0, len(hashIDPQAddress)+len(schemeFalcon1024)+1+len(pk))
	preimage = append(preimage, hashIDPQAddress...)
	preimage = append(preimage, schemeFalcon1024...)
	preimage = append(preimage, salt)
	preimage = append(preimage, pk...)
	return sha512.Sum512_256(preimage)
}

// canonicalSalt scans 0..255 for the lowest salt whose address digest cannot
// be decoded as an edwards25519 point (go-algorand basics.CanonicalPQAddressSalt).
func canonicalSalt(pk []byte) (byte, error) {
	for salt := 0; salt <= 255; salt++ {
		digest := pqAddressDigest(byte(salt), pk)
		if !isEdwards25519Point(digest[:]) {
			return byte(salt), nil
		}
	}
	// Probability ~2^-256 per go-algorand.
	return 0, errors.New("no canonical salt exists for this public key")
}

func isEdwards25519Point(encoded []byte) bool {
	_, err := new(edwards25519.Point).SetBytes(encoded)
	return err == nil
}

// encodeAddress renders a 32-byte address digest in the standard Algorand
// 58-char form: base32(digest || SHA512-256(digest)[28:]).
func encodeAddress(digest [32]byte) string {
	checksum := sha512.Sum512_256(digest[:])
	return base32NoPad.EncodeToString(append(digest[:], checksum[28:]...))
}
