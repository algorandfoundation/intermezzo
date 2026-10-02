package main

import (
	"log"

	"github.com/hashicorp/vault/sdk/plugin"
)

func main() {
	if err := plugin.ServeMultiplex(&plugin.ServeOpts{
		BackendFactoryFunc: Factory,
	}); err != nil {
		log.Fatal(err)
	}
}
