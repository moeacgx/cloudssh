#!/bin/sh
set -e

CLOUDSSH_ENTRYPOINT_PROTOCOL_VERSION=2
CLOUDSSH_IMAGE_APP_DIR="${CLOUDSSH_IMAGE_APP_DIR:-/app}"
CLOUDSSH_DATA_DIR="${DATA_DIR:-/app/data}"
CLOUDSSH_SELF_UPDATE_DIR="$CLOUDSSH_DATA_DIR/self-update"
CLOUDSSH_UPDATE_MODE_FILE="$CLOUDSSH_DATA_DIR/update-mode.txt"

read_app_version() {
    package_file="$1/package.json"
    if [ -f "$package_file" ]; then
        sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$package_file" | head -n 1
    fi
}

version_is_greater() {
    printf '%s\n%s\n' "$1" "$2" | awk '
        function parse(value) {
            sub(/^v/, "", value)
            if (value ~ /^[0-9]+\.[0-9]+\.[0-9]+-cloudssh\.[0-9]+$/) {
                sub(/-cloudssh\./, ".", value)
                return value
            }
            if (value ~ /^[0-9]+\.[0-9]+\.[0-9]+$/) {
                return value ".0"
            }
            return ""
        }
        NR == 1 { left = parse($0); next }
        NR == 2 {
            right = parse($0)
            if (left == "" || right == "") exit 1
            split(left, l, "."); split(right, r, ".")
            for (i = 1; i <= 4; i++) {
                if ((l[i] + 0) > (r[i] + 0)) exit 0
                if ((l[i] + 0) < (r[i] + 0)) exit 1
            }
            exit 1
        }
    '
}

valid_runtime_dir() {
    [ -f "$1/package.json" ] && \
        [ -f "$1/dist/backend/backend/starter.js" ] && \
        [ -f "$1/html/index.html" ] && \
        [ -d "$1/node_modules" ] && \
        [ -f "$1/nginx/nginx.conf.template" ] && \
        [ -f "$1/nginx/nginx-https.conf.template" ]
}

valid_runtime_pointer() {
    case "$1" in
        builtin) return 0 ;;
        releases/*)
            pointer_tail="${1#releases/}"
            [ -n "$pointer_tail" ] && \
                [ "${pointer_tail#*[!A-Za-z0-9._-]}" = "$pointer_tail" ]
            ;;
        *) return 1 ;;
    esac
}

read_runtime_pointer() {
    pointer_file="$CLOUDSSH_SELF_UPDATE_DIR/$1"
    if [ -f "$pointer_file" ]; then
        pointer="$(tr -d '\r\n' < "$pointer_file")"
        if valid_runtime_pointer "$pointer"; then
            printf '%s' "$pointer"
            return
        fi
    fi
    printf '%s' builtin
}

runtime_dir_for_pointer() {
    if [ "$1" = builtin ]; then
        printf '%s' "$CLOUDSSH_IMAGE_APP_DIR"
    else
        printf '%s' "$CLOUDSSH_SELF_UPDATE_DIR/$1"
    fi
}

select_runtime_dir() {
    mode_source="${CLOUDSSH_UPDATE_MODE:-auto}"
    if [ -f "$CLOUDSSH_UPDATE_MODE_FILE" ]; then
        mode_source="$(cat "$CLOUDSSH_UPDATE_MODE_FILE")"
    fi
    CLOUDSSH_UPDATE_MODE="$(printf '%s' "$mode_source" | tr -d '\r\n' | tr '[:upper:]' '[:lower:]')"
    case "$CLOUDSSH_UPDATE_MODE" in
        auto|image|binary) ;;
        *) CLOUDSSH_UPDATE_MODE=auto ;;
    esac
    CLOUDSSH_IMAGE_VERSION="$(read_app_version "$CLOUDSSH_IMAGE_APP_DIR")"

    mkdir -p "$CLOUDSSH_SELF_UPDATE_DIR"
    current_pointer="$(read_runtime_pointer app-current)"
    previous_pointer="$(read_runtime_pointer app-previous)"
    pending_marker="$CLOUDSSH_SELF_UPDATE_DIR/pending.json"
    attempted_marker="$CLOUDSSH_SELF_UPDATE_DIR/boot-attempted"

    # pending 在完整启动后才由后端移除。若同一 pending 已尝试过，说明新包
    # 在确认前退出；先恢复上一指针，让旧版本启动后把任务标记为失败。
    if [ -f "$pending_marker" ]; then
        if [ -f "$attempted_marker" ]; then
            current_pointer="$previous_pointer"
            printf '%s\n' "$current_pointer" > "$CLOUDSSH_SELF_UPDATE_DIR/app-current"
            rm -f "$attempted_marker"
            echo "The pending runtime did not confirm startup; restored app-previous."
        else
            date -u +%Y-%m-%dT%H:%M:%SZ > "$attempted_marker"
        fi
    else
        rm -f "$attempted_marker"
    fi

    CLOUDSSH_ACTIVE_APP_SOURCE=image
    CLOUDSSH_ACTIVE_APP_DIR="$CLOUDSSH_IMAGE_APP_DIR"
    if [ "$CLOUDSSH_UPDATE_MODE" = image ] || [ "$current_pointer" = builtin ]; then
        return
    fi

    candidate_dir="$(runtime_dir_for_pointer "$current_pointer")"
    if ! valid_runtime_dir "$candidate_dir"; then
        echo "Persisted runtime pointer is incomplete; using the image runtime."
        return
    fi

    if [ "$CLOUDSSH_UPDATE_MODE" = auto ]; then
        image_version="$CLOUDSSH_IMAGE_VERSION"
        updated_version="$(read_app_version "$candidate_dir")"
        if [ -n "$image_version" ] && version_is_greater "$image_version" "$updated_version"; then
            echo "Image version $image_version is newer than persisted runtime $updated_version."
            return
        fi
    fi

    CLOUDSSH_ACTIVE_APP_SOURCE=binary
    CLOUDSSH_ACTIVE_APP_DIR="$candidate_dir"
}

if [ -n "${CLOUDSSH_SELECTED_APP_DIR:-}" ]; then
    CLOUDSSH_ACTIVE_APP_DIR="$CLOUDSSH_SELECTED_APP_DIR"
    CLOUDSSH_ACTIVE_APP_SOURCE="${CLOUDSSH_ACTIVE_APP_SOURCE:-binary}"
    CLOUDSSH_UPDATE_MODE="${CLOUDSSH_UPDATE_MODE:-auto}"
else
    select_runtime_dir
fi

persisted_entrypoint="$CLOUDSSH_ACTIVE_APP_DIR/self-update/entrypoint.sh"
if [ -z "${CLOUDSSH_ENTRYPOINT_DELEGATED:-}" ] && \
   [ "$CLOUDSSH_ACTIVE_APP_SOURCE" = binary ] && \
   [ -f "$persisted_entrypoint" ]; then
    persisted_protocol="$(sed -n 's/^CLOUDSSH_ENTRYPOINT_PROTOCOL_VERSION=\([0-9][0-9]*\)$/\1/p' "$persisted_entrypoint" | head -n 1)"
    if [ -n "$persisted_protocol" ] && [ "$persisted_protocol" -ge "$CLOUDSSH_ENTRYPOINT_PROTOCOL_VERSION" ]; then
        export CLOUDSSH_ENTRYPOINT_DELEGATED=1
        export CLOUDSSH_SELECTED_APP_DIR="$CLOUDSSH_ACTIVE_APP_DIR"
        export CLOUDSSH_ACTIVE_APP_SOURCE CLOUDSSH_UPDATE_MODE CLOUDSSH_IMAGE_VERSION
        exec /bin/sh "$persisted_entrypoint" "$@"
    fi
fi

export CLOUDSSH_ACTIVE_APP_DIR CLOUDSSH_ACTIVE_APP_SOURCE CLOUDSSH_UPDATE_MODE CLOUDSSH_IMAGE_VERSION

PUID=${PUID:-1000}
PGID=${PGID:-1000}

if [ "$(id -u)" = "0" ]; then
    if [ "$PUID" = "0" ]; then
        echo "Running as root (PUID=0, PGID=$PGID)"
        chown -R root:root /app/data /app/uploads /tmp/nginx 2>/dev/null || true
    else
        echo "Setting up user permissions (PUID: $PUID, PGID: $PGID)..."

        groupmod -o -g "$PGID" node 2>/dev/null || true
        usermod -o -u "$PUID" node 2>/dev/null || true

        chown -R node:node /app/data /app/uploads "$CLOUDSSH_ACTIVE_APP_DIR/html" /tmp/nginx 2>/dev/null || true

        echo "User node is now UID: $PUID, GID: $PGID"

        export CLOUDSSH_SELECTED_APP_DIR="$CLOUDSSH_ACTIVE_APP_DIR"
        exec gosu node:node "$0" "$@"
    fi
fi

export PORT=${PORT:-8080}
export ENABLE_SSL=${ENABLE_SSL:-false}
export SSL_PORT=${SSL_PORT:-8443}
export SSL_CERT_PATH=${SSL_CERT_PATH:-/app/data/ssl/termix.crt}
export SSL_KEY_PATH=${SSL_KEY_PATH:-/app/data/ssl/termix.key}

normalize_proxy_cidrs() {
    python3 - "$1" <<'PY'
import ipaddress
import sys

values = [value.strip() for value in sys.argv[1].split(",")]
if not values or any(not value for value in values) or len(values) > 64:
    raise SystemExit(1)

normalized = []
try:
    for value in values:
        network = str(ipaddress.ip_network(value, strict=False))
        if network not in normalized:
            normalized.append(network)
except ValueError:
    raise SystemExit(1)

print("\n".join(normalized))
PY
}

detect_docker_gateway_cidr() {
    python3 <<'PY'
import socket
import struct

with open("/proc/net/route", encoding="ascii") as routes:
    next(routes, None)
    for route in routes:
        fields = route.split()
        if len(fields) < 4 or fields[1] != "00000000":
            continue
        flags = int(fields[3], 16)
        if not flags & 0x2:
            continue
        gateway = socket.inet_ntoa(struct.pack("<I", int(fields[2], 16)))
        print(f"{gateway}/32")
        break
    else:
        raise SystemExit(1)
PY
}

if [ -n "${CLOUDSSH_TRUSTED_PROXY_CIDR:-}" ]; then
    if ! NORMALIZED_TRUSTED_PROXY_CIDRS=$(normalize_proxy_cidrs "$CLOUDSSH_TRUSTED_PROXY_CIDR"); then
        echo "ERROR: CLOUDSSH_TRUSTED_PROXY_CIDR must contain one or more valid comma-separated IP addresses or CIDRs" >&2
        exit 1
    fi
elif [ -f /.dockerenv ] && NORMALIZED_TRUSTED_PROXY_CIDRS=$(detect_docker_gateway_cidr); then
    :
else
    # 非 Docker 环境默认只信任本机回环代理，避免意外信任局域网或公网来源。
    NORMALIZED_TRUSTED_PROXY_CIDRS="127.0.0.1/32"
fi

CLOUDSSH_TRUSTED_PROXY_SET_REAL_IP=$(
    printf '%s\n' "$NORMALIZED_TRUSTED_PROXY_CIDRS" |
        sed 's/^/    set_real_ip_from /; s/$/;/'
)
CLOUDSSH_TRUSTED_PROXY_GEO=$(
    printf '%s\n' "$NORMALIZED_TRUSTED_PROXY_CIDRS" |
        sed 's/^/        /; s/$/ 1;/'
)
export CLOUDSSH_TRUSTED_PROXY_SET_REAL_IP CLOUDSSH_TRUSTED_PROXY_GEO

echo "Configuring web UI to run on port: $PORT"
echo "Trusted reverse proxy sources: $(printf '%s' "$NORMALIZED_TRUSTED_PROXY_CIDRS" | tr '\n' ',')"

if [ "$ENABLE_SSL" = "true" ]; then
    echo "SSL enabled - using HTTPS configuration with redirect"
    NGINX_CONF_SOURCE="$CLOUDSSH_ACTIVE_APP_DIR/nginx/nginx-https.conf.template"
else
    echo "SSL disabled - using HTTP-only configuration (default)"
    NGINX_CONF_SOURCE="$CLOUDSSH_ACTIVE_APP_DIR/nginx/nginx.conf.template"
fi

mkdir -p /tmp/nginx
envsubst '${PORT} ${SSL_PORT} ${SSL_CERT_PATH} ${SSL_KEY_PATH} ${CLOUDSSH_TRUSTED_PROXY_SET_REAL_IP} ${CLOUDSSH_TRUSTED_PROXY_GEO} ${CLOUDSSH_ACTIVE_APP_DIR}' < "$NGINX_CONF_SOURCE" > /tmp/nginx/nginx.conf

mkdir -p /app/data /app/uploads /app/data/.opk /app/data/acme-webroot/.well-known/acme-challenge
chmod 755 /app/data /app/uploads /app/data/.opk 2>/dev/null || true

if [ -w /app/data ]; then
    echo "Data directory is writable"
else
    echo "WARNING: Data directory is not writable. OPKSSH may fail."
    ls -ld /app/data
fi

if [ -w /app/data/.opk ]; then
    echo "OPKSSH directory is writable"
else
    echo "WARNING: OPKSSH directory is not writable. OPKSSH authentication will fail."
    ls -ld /app/data/.opk
fi

OPKSSH_DIR="${DATA_DIR:-/app/data}/opkssh"
if [ ! -d "$OPKSSH_DIR" ]; then
    echo "WARNING: OPKSSH binary directory not found at $OPKSSH_DIR"
    echo "OPKSSH will be downloaded automatically on first use."
else
    echo "OPKSSH binary directory found at $OPKSSH_DIR"
fi

if [ "$ENABLE_SSL" = "true" ]; then
    echo "Checking SSL certificate configuration..."
    mkdir -p /app/data/ssl
    chmod 755 /app/data/ssl 2>/dev/null || true

    DOMAIN=${SSL_DOMAIN:-localhost}
    
    if [ -f "/app/data/ssl/termix.crt" ] && [ -f "/app/data/ssl/termix.key" ]; then
        echo "SSL certificates found, checking validity..."
        
        if openssl x509 -in /app/data/ssl/termix.crt -checkend 2592000 -noout >/dev/null 2>&1; then
            echo "SSL certificates are valid and will be reused for domain: $DOMAIN"
        else
            echo "SSL certificate is expired or expiring soon, regenerating..."
            rm -f /app/data/ssl/termix.crt /app/data/ssl/termix.key
        fi
    else
        echo "SSL certificates not found, will generate new ones..."
    fi
    
    if [ ! -f "/app/data/ssl/termix.crt" ] || [ ! -f "/app/data/ssl/termix.key" ]; then
        echo "Generating SSL certificates for domain: $DOMAIN"

        cat > /app/data/ssl/openssl.conf << EOF
[req]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
req_extensions = v3_req

[dn]
C=US
ST=State
L=City
O=Termix
OU=IT Department
CN=$DOMAIN

[v3_req]
basicConstraints = CA:FALSE
keyUsage = nonRepudiation, digitalSignature, keyEncipherment
subjectAltName = @alt_names

[alt_names]
DNS.1 = $DOMAIN
DNS.2 = localhost
DNS.3 = 127.0.0.1
IP.1 = 127.0.0.1
IP.2 = ::1
IP.3 = 0.0.0.0
EOF

        openssl genrsa -out /app/data/ssl/termix.key 2048

        openssl req -new -x509 -key /app/data/ssl/termix.key -out /app/data/ssl/termix.crt -days 365 -config /app/data/ssl/openssl.conf -extensions v3_req

        chmod 600 /app/data/ssl/termix.key
        chmod 644 /app/data/ssl/termix.crt

        rm -f /app/data/ssl/openssl.conf
        
        echo "SSL certificates generated successfully for domain: $DOMAIN"
    fi
fi

echo "Starting nginx..."
nginx -c /tmp/nginx/nginx.conf

# Inject runtime BASE_PATH into frontend if configured
if [ -n "$BASE_PATH" ]; then
    echo "Injecting BASE_PATH: $BASE_PATH"
    # Strip trailing slash for use as a path prefix
    CLEAN_BASE_PATH="${BASE_PATH%/}"
    find "$CLOUDSSH_ACTIVE_APP_DIR/html" -name "index.html" -exec sed -i "s|window.__TERMIX_BASE_PATH__ = \"\"|window.__TERMIX_BASE_PATH__ = \"$CLEAN_BASE_PATH\"|g" {} \;
    # Patch sw.js static asset paths with the base path prefix
    find "$CLOUDSSH_ACTIVE_APP_DIR/html" -name "sw.js" -exec sed -i "s|__TERMIX_SW_BASE_PATH__|$CLEAN_BASE_PATH|g" {} \;
else
    # No base path - replace placeholder with empty string so paths stay absolute from root
    find "$CLOUDSSH_ACTIVE_APP_DIR/html" -name "sw.js" -exec sed -i "s|__TERMIX_SW_BASE_PATH__||g" {} \;
fi

echo "Starting backend services..."
cd "$CLOUDSSH_ACTIVE_APP_DIR"
export NODE_ENV=production

if [ -f "package.json" ]; then
    VERSION=$(grep '"version"' package.json | sed 's/.*"version": *"\([^"]*\)".*/\1/')
    if [ -n "$VERSION" ]; then
        export VERSION
    else
        echo "Warning: Could not extract version from package.json"
    fi
else
    echo "Warning: package.json not found"
fi

# 让 Node 成为 PID 1，Docker 的 TERM/INT 才能直接触发应用的优雅关机。
# Nginx 以守护进程运行，会在容器随 Node 退出后由运行时一并终止。
exec node dist/backend/backend/starter.js
