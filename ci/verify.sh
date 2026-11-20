#!/bin/sh
set -eu

export CI=true
npm ci
npm run verify
