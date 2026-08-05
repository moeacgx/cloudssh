#!/bin/sh
set -eu

entrypoint="${1:-/entrypoint.sh}"
functions="$(sed -n '1,/^valid_runtime_dir()/p' "$entrypoint" | sed '$d')"
eval "$functions"

version_is_greater 2.6.0-cloudssh.29 2.6.0-cloudssh.28
! version_is_greater 2.6.0-cloudssh.28 2.6.0-cloudssh.29
version_is_greater 3.0.0 2.6.0-cloudssh.99
! version_is_greater invalid 2.6.0-cloudssh.28
