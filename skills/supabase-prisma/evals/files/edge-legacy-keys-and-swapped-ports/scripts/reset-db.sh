#!/usr/bin/env bash
set -euo pipefail
yarn prisma migrate reset --force
