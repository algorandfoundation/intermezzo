package main

import (
	"crypto/sha512"
	"errors"

	"github.com/algorand/falcon"
)

// Key-generation constants mirrored from go-algorand's Falcon-1024 profile.
const (
	hashIDPQKey = "PQK"

	schemeFalcon1024 = "f1"
	entropySize      = 32
)

// deriveKey deterministically derives a Falcon-1024 keypair from 32 bytes of
// mnemonic entropy: keygen seed = SHA512-256("PQK" || "f1" || entropy).
func deriveKey(entropy []byte) (falcon.PublicKey, falcon.PrivateKey, error) {
	if len(entropy) != entropySize {
		return falcon.PublicKey{}, falcon.PrivateKey{}, errors.New("entropy must be 32 bytes")
	}
	seed := sha512.Sum512_256([]byte(hashIDPQKey + schemeFalcon1024 + string(entropy)))
	return falcon.GenerateKey(seed[:])
}
