package main

import (
	_ "embed"
	"strings"
)

//go:embed VERSION
var embeddedPluginVersion string

var pluginVersion = strings.TrimSpace(embeddedPluginVersion)