import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const configurations = ["docker/nginx.conf", "docker/nginx-https.conf"];

function extractLocation(configuration: string, marker: string): string {
  const start = configuration.indexOf(marker);
  if (start < 0) return "";
  const end = configuration.indexOf("\\n        }", start);
  return end < 0 ? configuration.slice(start) : configuration.slice(start, end);
}

describe.each(configurations)("%s Agent 入口安全约束", (filePath) => {
  const configuration = readFileSync(filePath, "utf8");

  it("仅按原始直连地址信任经过校验的代理网段", () => {
    expect(configuration).toContain("${CLOUDSSH_TRUSTED_PROXY_SET_REAL_IP}");
    expect(configuration).toContain(
      "geo $realip_remote_addr $cloudssh_is_trusted_proxy",
    );
    expect(configuration).toMatch(
      /geo \$realip_remote_addr \$cloudssh_is_trusted_proxy \{[\s\S]*?default 0;[\s\S]*?\$\{CLOUDSSH_TRUSTED_PROXY_GEO\}/,
    );
    expect(configuration).not.toContain(
      "geo $remote_addr $cloudssh_is_trusted_proxy",
    );
  });

  it("不信任非可信来源伪造的协议、主机和端口", () => {
    expect(configuration).toContain(
      'map "$cloudssh_is_trusted_proxy:$http_x_forwarded_proto" $proxy_x_forwarded_proto',
    );
    expect(configuration).toMatch(
      /map "\$cloudssh_is_trusted_proxy:\$http_x_forwarded_proto" \$proxy_x_forwarded_proto \{[\s\S]*?default\s+\$scheme;[\s\S]*?"1:http"\s+http;[\s\S]*?"1:https"\s+https;/,
    );
    expect(configuration).toMatch(
      /map \$cloudssh_is_trusted_proxy \$trusted_x_forwarded_host \{[\s\S]*?default '';[\s\S]*?1\s+\$http_x_forwarded_host;/,
    );
    expect(configuration).toMatch(
      /map \$trusted_x_forwarded_host \$proxy_x_forwarded_host \{[\s\S]*?default \$trusted_x_forwarded_host;[\s\S]*?''\s+\$http_host;/,
    );
    expect(configuration).toMatch(
      /map \$cloudssh_is_trusted_proxy \$proxy_x_forwarded_port \{[\s\S]*?default '';[\s\S]*?1\s+\$http_x_forwarded_port;/,
    );
    expect(configuration).not.toMatch(
      /map\s+\$http_x_forwarded_proto\s+\$proxy_x_forwarded_proto/,
    );
  });

  it("对 Agent API 按来源 IP 限速并覆盖客户端转发地址", () => {
    expect(configuration).toContain(
      "limit_req_zone $binary_remote_addr zone=agent_api_per_ip:10m rate=20r/s;",
    );
    expect(configuration).toMatch(
      /location \^~ \/agent\/ \{[\s\S]*?limit_req zone=agent_api_per_ip burst=40 nodelay;/,
    );
    expect(configuration).toMatch(
      /location \^~ \/agent\/ \{[\s\S]*?proxy_set_header X-Forwarded-For \$remote_addr;/,
    );
  });

  it("把面板 Agent 设置和聊天接口转发到控制面", () => {
    const location = extractLocation(
      configuration,
      "location ~ ^/panel-agent(/.*)?$ {",
    );
    expect(location).not.toBe("");
    expect(location).toContain("client_max_body_size 64m;");
    expect(location).toContain("client_body_timeout 300s;");
    expect(location).toContain("proxy_pass http://127.0.0.1:30001;");
    expect(location).toContain(
      "proxy_set_header X-Forwarded-Proto $proxy_x_forwarded_proto;",
    );
    expect(location).toContain(
      "proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
    );
    expect(location).toContain("proxy_read_timeout 300s;");
  });

  it("把管理员更新接口转发到控制面并禁止缓存", () => {
    const location = extractLocation(
      configuration,
      "location ~ ^/admin/updates(/.*)?$ {",
    );
    expect(location).not.toBe("");
    expect(location).toContain("proxy_pass http://127.0.0.1:30001;");
    expect(location).toContain(
      "proxy_set_header X-Forwarded-Proto $proxy_x_forwarded_proto;",
    );
    expect(location).toContain(
      "proxy_set_header X-Forwarded-For $remote_addr;",
    );
    expect(location).toContain(
      'add_header Cache-Control "private, no-store" always;',
    );
  });
});

describe("可信代理运行时配置", () => {
  const entrypoint = readFileSync("docker/entrypoint.sh", "utf8");
  const compose = readFileSync("docker/docker-compose.cloudssh.yml", "utf8");

  it("默认只信任 Docker 宿主机网关的单个地址", () => {
    expect(entrypoint).toContain("elif [ -f /.dockerenv ]");
    expect(entrypoint).toContain("/proc/net/route");
    expect(entrypoint).toContain('print(f"{gateway}/32")');
    expect(entrypoint).toContain(
      'NORMALIZED_TRUSTED_PROXY_CIDRS="127.0.0.1/32"',
    );
  });

  it("校验、去重并向 Nginx 模板注入多个显式 CIDR", () => {
    expect(entrypoint).toContain(
      'values = [value.strip() for value in sys.argv[1].split(",")]',
    );
    expect(entrypoint).toContain(
      "network = str(ipaddress.ip_network(value, strict=False))",
    );
    expect(entrypoint).toContain("if network not in normalized:");
    expect(entrypoint).toContain(
      "${CLOUDSSH_TRUSTED_PROXY_SET_REAL_IP} ${CLOUDSSH_TRUSTED_PROXY_GEO} ${CLOUDSSH_ACTIVE_APP_DIR}' <",
    );
    expect(compose).toContain(
      'CLOUDSSH_TRUSTED_PROXY_CIDR: "${CLOUDSSH_TRUSTED_PROXY_CIDR:-}"',
    );
  });
});
