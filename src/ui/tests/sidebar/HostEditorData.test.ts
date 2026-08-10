import { describe, it, expect } from "vitest";
import {
  applyHostDefaultsToNewHostForm,
  buildProjectHostMetadataInput,
  createHostEditorForm,
  buildHostEditorPayload,
  isSshPasswordRequiredForSave,
  preserveGlobalHostMetadata,
  type HostProtocols,
} from "../../sidebar/HostEditorData";
import type { Host } from "@/types/ui-types";

const sshOnly: HostProtocols = {
  enableSsh: true,
  enableRdp: false,
  enableVnc: false,
  enableTelnet: false,
};

const rdpOnly: HostProtocols = {
  enableSsh: false,
  enableRdp: true,
  enableVnc: false,
  enableTelnet: false,
};

const vncOnly: HostProtocols = {
  enableSsh: false,
  enableRdp: false,
  enableVnc: true,
  enableTelnet: false,
};

const telnetOnly: HostProtocols = {
  enableSsh: false,
  enableRdp: false,
  enableVnc: false,
  enableTelnet: true,
};

describe("applyHostDefaultsToNewHostForm", () => {
  it("does not overwrite fields after the user has started editing", () => {
    const current = {
      ...createHostEditorForm(null),
      name: "已输入主机",
      password: "user-secret",
    };

    const result = applyHostDefaultsToNewHostForm(
      current,
      { fontSize: 18 } as never,
      "生产",
      true,
    );

    expect(result).toBe(current);
    expect(result.password).toBe("user-secret");
    expect(result.name).toBe("已输入主机");
  });

  it("applies defaults and the requested project folder to a pristine form", () => {
    const result = applyHostDefaultsToNewHostForm(
      createHostEditorForm(null),
      { fontSize: 18 } as never,
      "生产",
      false,
    );

    expect(result.fontSize).toBe(18);
    expect(result.folder).toBe("生产");
  });
});

describe("buildHostEditorPayload auth field isolation", () => {
  it("marks an existing SSH password without exposing it in the form", () => {
    const form = createHostEditorForm({
      authType: "password",
      hasPassword: true,
    } as Host);

    expect(form.password).toBe("");
    expect(form.passwordSaved).toBe(true);
  });

  it("omits an unchanged saved SSH password so an edit cannot erase it", () => {
    const form = createHostEditorForm({
      authType: "password",
      hasPassword: true,
    } as Host);

    const payload = buildHostEditorPayload(form, sshOnly);

    expect(payload.password).toBeUndefined();
  });

  it.each(["key", "credential"] as const)(
    "preserves an unchanged optional SSH password for %s authentication",
    (authType) => {
      const form = {
        ...createHostEditorForm({
          authType,
          hasPassword: true,
          hasKey: authType === "key",
          credentialId: authType === "credential" ? "7" : undefined,
        } as Host),
        authType,
      };

      const payload = buildHostEditorPayload(form, sshOnly);

      expect(payload.password).toBeUndefined();
    },
  );

  it("sends a replacement for a previously saved SSH password", () => {
    const form = {
      ...createHostEditorForm({
        authType: "password",
        hasPassword: true,
      } as Host),
      password: "replacement-secret",
    };

    const payload = buildHostEditorPayload(form, sshOnly);

    expect(payload.password).toBe("replacement-secret");
  });

  it("only sends the password when authType is password", () => {
    const form = {
      ...createHostEditorForm(null),
      authType: "password" as const,
      password: "hunter2",
      key: "PRIVATE KEY",
      keyPassword: "kp",
      credentialId: "5",
    };

    const payload = buildHostEditorPayload(form, sshOnly);

    expect(payload.password).toBe("hunter2");
    expect(payload.key).toBeNull();
    expect(payload.keyPassword).toBeNull();
    expect(payload.credentialId).toBeNull();
  });

  it("drops the credentialId when switching a cloned host away from credential auth", () => {
    const form = {
      ...createHostEditorForm(null),
      authType: "password" as const,
      password: "newpass",
      credentialId: "12",
    };

    const payload = buildHostEditorPayload(form, sshOnly);

    expect(payload.credentialId).toBeNull();
    expect(payload.password).toBe("newpass");
  });

  it("sends credentialId and optional password when authType is credential", () => {
    const form = {
      ...createHostEditorForm(null),
      authType: "credential" as const,
      credentialId: "7",
      password: "host-specific-password",
      key: "leftover-key",
    };

    const payload = buildHostEditorPayload(form, sshOnly);

    expect(payload.credentialId).toBe(7);
    expect(payload.password).toBe("host-specific-password");
    expect(payload.key).toBeNull();
  });

  it("sends key fields and optional password when authType is key", () => {
    const form = {
      ...createHostEditorForm(null),
      authType: "key" as const,
      key: "MY KEY",
      keyType: "ssh-ed25519",
      password: "leftover",
      credentialId: "3",
    };

    const payload = buildHostEditorPayload(form, sshOnly);

    expect(payload.key).toBe("MY KEY");
    expect(payload.keyType).toBe("ssh-ed25519");
    expect(payload.password).toBe("leftover");
    expect(payload.credentialId).toBeNull();
  });

  it("preserves agentSocketPath in terminalConfig when authType is agent", () => {
    const form = {
      ...createHostEditorForm(null),
      authType: "agent" as const,
      agentSocketPath: "/run/user/1000/gnupg/S.gpg-agent.ssh",
    };

    const payload = buildHostEditorPayload(form, sshOnly);
    const tc = payload.terminalConfig as Record<string, unknown> | null;

    expect(tc?.agentSocketPath).toBe("/run/user/1000/gnupg/S.gpg-agent.ssh");
    expect(payload.password).toBeNull();
    expect(payload.key).toBeNull();
  });

  it("sets agentSocketPath to null in payload when authType is agent but path is empty", () => {
    const form = {
      ...createHostEditorForm(null),
      authType: "agent" as const,
      agentSocketPath: "",
    };

    const payload = buildHostEditorPayload(form, sshOnly);
    const tc = payload.terminalConfig as Record<string, unknown> | null;

    expect(tc?.agentSocketPath).toBeNull();
  });

  it("nulls out agentSocketPath when switching away from agent auth", () => {
    const form = {
      ...createHostEditorForm(null),
      authType: "password" as const,
      password: "mypass",
      agentSocketPath: "/run/user/1000/gnupg/S.gpg-agent.ssh",
    };

    const payload = buildHostEditorPayload(form, sshOnly);
    const tc = payload.terminalConfig as Record<string, unknown> | null;

    expect(tc?.agentSocketPath).toBeNull();
  });

  it("preserves sudo password autofill settings", () => {
    const form = {
      ...createHostEditorForm(null),
      sudoPasswordAutoFill: true,
      sudoPassword: "sudo-secret",
    };

    const payload = buildHostEditorPayload(form, sshOnly);
    const tc = payload.terminalConfig as Record<string, unknown> | null;

    expect(tc?.sudoPasswordAutoFill).toBe(true);
    expect(tc?.sudoPassword).toBe("sudo-secret");
  });

  it("includes the unfinished tag draft when saving immediately", () => {
    const form = {
      ...createHostEditorForm(null),
      tags: ["Canvas"],
      tagInput: "test，ops  test",
    };

    const payload = buildHostEditorPayload(form, sshOnly);

    expect(payload.tags).toEqual(["Canvas", "test", "ops"]);
  });

  it("persists the create-as-pinned preference in terminalConfig", () => {
    expect(createHostEditorForm(null).startPinned).toBe(false);

    const form = {
      ...createHostEditorForm(null),
      startPinned: true,
      autoTmux: true,
    };

    const payload = buildHostEditorPayload(form, sshOnly);
    const tc = payload.terminalConfig as Record<string, unknown> | null;

    expect(tc?.startPinned).toBe(true);
    expect(tc?.autoTmux).toBe(false);
    expect(
      createHostEditorForm({ terminalConfig: tc } as unknown as Host)
        .startPinned,
    ).toBe(true);
  });
});

describe("isSshPasswordRequiredForSave", () => {
  it("accepts an unchanged password-auth host with a saved direct password", () => {
    const form = createHostEditorForm({
      authType: "password",
      hasPassword: true,
    } as Host);

    expect(isSshPasswordRequiredForSave(form, sshOnly, "password")).toBe(false);
  });

  it("requires a password when switching from credential authentication", () => {
    const form = {
      ...createHostEditorForm({
        authType: "credential",
        credentialId: "7",
        hasPassword: true,
      } as Host),
      authType: "password" as const,
    };

    expect(isSshPasswordRequiredForSave(form, sshOnly, "credential")).toBe(
      true,
    );
  });

  it("accepts a newly entered password after changing authentication type", () => {
    const form = {
      ...createHostEditorForm({
        authType: "credential",
        credentialId: "7",
        hasPassword: true,
      } as Host),
      authType: "password" as const,
      password: "new-direct-secret",
    };

    expect(isSshPasswordRequiredForSave(form, sshOnly, "credential")).toBe(
      false,
    );
  });

  it("does not require an SSH password when SSH is disabled", () => {
    const form = createHostEditorForm(null);

    expect(isSshPasswordRequiredForSave(form, rdpOnly)).toBe(false);
  });
});

describe("project-scoped host metadata", () => {
  it("keeps the global host name and folder out of project metadata edits", () => {
    const payload = {
      ...buildHostEditorPayload(createHostEditorForm(null), sshOnly),
      name: "项目入口",
      folder: "生产 / Web",
    };
    const host = {
      id: "7",
      name: "项目入口",
      folder: "生产 / Web",
      sourceName: "Global host",
      sourceFolder: "Shared inventory",
    } as Host;

    expect(preserveGlobalHostMetadata(payload, host)).toMatchObject({
      name: "Global host",
      folder: "Shared inventory",
    });
    expect(payload).toMatchObject({
      name: "项目入口",
      folder: "生产 / Web",
    });
  });

  it("updates the personal project folder while keeping its name on the host", () => {
    const payload = {
      ...buildHostEditorPayload(createHostEditorForm(null), sshOnly),
      name: "个人主机",
      folder: "个人 / 生产",
    };

    expect(buildProjectHostMetadataInput(payload, "personal")).toEqual({
      alias: null,
      folder: "个人 / 生产",
    });
  });

  it("stores team project names as project aliases", () => {
    const payload = {
      ...buildHostEditorPayload(createHostEditorForm(null), sshOnly),
      name: "项目入口",
      folder: "团队 / 生产",
    };

    expect(buildProjectHostMetadataInput(payload, "team")).toEqual({
      alias: "项目入口",
      folder: "团队 / 生产",
    });
  });
});

describe("RDP/VNC/Telnet password persistence indicator", () => {
  it("seeds a sentinel value when the host reports a saved rdp password", () => {
    const host = {
      hasRdpPassword: true,
      rdpAuthType: "direct",
    } as Host;

    const form = createHostEditorForm(host);

    expect(form.rdpPassword).toBe("existing_rdp_password");
  });

  it("does not send the rdp sentinel back to the backend unchanged", () => {
    const host = { hasRdpPassword: true, rdpAuthType: "direct" } as Host;
    const form = { ...createHostEditorForm(host) };

    const payload = buildHostEditorPayload(form, rdpOnly);

    expect(payload.rdpPassword).toBeNull();
  });

  it("sends a newly typed rdp password", () => {
    const host = { hasRdpPassword: true, rdpAuthType: "direct" } as Host;
    const form = {
      ...createHostEditorForm(host),
      rdpPassword: "new-rdp-pass",
    };

    const payload = buildHostEditorPayload(form, rdpOnly);

    expect(payload.rdpPassword).toBe("new-rdp-pass");
  });

  it("seeds a sentinel value when the host reports a saved vnc password", () => {
    const host = { hasVncPassword: true, vncAuthType: "direct" } as Host;
    const form = createHostEditorForm(host);

    expect(form.vncPassword).toBe("existing_vnc_password");
  });

  it("does not send the vnc sentinel back to the backend unchanged", () => {
    const host = { hasVncPassword: true, vncAuthType: "direct" } as Host;
    const form = { ...createHostEditorForm(host) };

    const payload = buildHostEditorPayload(form, vncOnly);

    expect(payload.vncPassword).toBeNull();
  });

  it("seeds a sentinel value when the host reports a saved telnet password", () => {
    const host = {
      hasTelnetPassword: true,
      telnetAuthType: "direct",
    } as Host;
    const form = createHostEditorForm(host);

    expect(form.telnetPassword).toBe("existing_telnet_password");
  });

  it("does not send the telnet sentinel back to the backend unchanged", () => {
    const host = {
      hasTelnetPassword: true,
      telnetAuthType: "direct",
    } as Host;
    const form = { ...createHostEditorForm(host) };

    const payload = buildHostEditorPayload(form, telnetOnly);

    expect(payload.telnetPassword).toBeNull();
  });
});
