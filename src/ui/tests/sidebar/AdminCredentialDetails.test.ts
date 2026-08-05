import { describe, expect, it } from "vitest";
import { mapCredentialDetails } from "@/sidebar/HostManagerData";

describe("mapCredentialDetails", () => {
  it("keeps administrator-visible password, private key and passphrase", () => {
    expect(
      mapCredentialDetails({
        id: 7,
        name: "Production",
        username: "deploy",
        authType: "key",
        password: "password-value",
        key: "private-key-value",
        keyPassword: "passphrase-value",
        publicKey: "ssh-ed25519 public-key-value",
      }),
    ).toMatchObject({
      id: "7",
      type: "key",
      password: "password-value",
      value: "private-key-value",
      passphrase: "passphrase-value",
    });
  });

  it("preserves existing-secret markers when no plaintext is returned", () => {
    expect(
      mapCredentialDetails({
        id: 8,
        name: "Existing",
        username: "root",
        authType: "key",
        hasKey: true,
        hasKeyPassword: true,
      }),
    ).toMatchObject({
      value: "existing_key",
      passphrase: "existing_key_password",
    });
  });

  it("maps a password credential into the editor's primary value", () => {
    expect(
      mapCredentialDetails({
        id: 9,
        name: "Password",
        username: "root",
        authType: "password",
        password: "password-value",
      }),
    ).toMatchObject({
      type: "password",
      value: "password-value",
      password: "password-value",
    });
  });
});
