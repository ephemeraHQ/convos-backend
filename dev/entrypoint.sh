#!/bin/sh
set -e

bun migrate:deploy
exec bun start
