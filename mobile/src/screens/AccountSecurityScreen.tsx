import { useEffect, useState } from "react";
import {
  Alert,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { apiFetch } from "../api/client";
import { PrimaryButton } from "../components/PrimaryButton";
import { colors } from "../theme/tokens";

type State = {
  mfaEnabled: boolean;
  mfaRequired: boolean;
  recoveryCodesRemaining: number;
  currentSessionId: string | null;
  sessions: { id: string; device_label: string; created_at: string }[];
};
export function AccountSecurityScreen({
  token,
  mode,
  onClose,
  onSignOut,
}: {
  token: string;
  mode: "staff" | "client";
  onClose: () => void;
  onSignOut: () => void;
}) {
  const [state, setState] = useState<State | null>(null),
    [password, setPassword] = useState(""),
    [secret, setSecret] = useState(""),
    [code, setCode] = useState(""),
    [recovery, setRecovery] = useState<string[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [note, setNote] = useState("");
  const base =
    mode === "staff" ? "/api/account-security" : "/portal/account-security";
  const request = <T,>(path: string, body?: unknown) =>
    apiFetch<T>(
      base + path,
      { ...(body ? { method: "POST", body: JSON.stringify(body) } : {}) },
      token,
    );
  async function load() {
    setState(await request<State>(""));
  }
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [token]);
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Please try again.");
    } finally {
      setBusy(false);
    }
  }
  const input = {
    borderWidth: 1,
    borderColor: "#ffffff30",
    borderRadius: 8,
    padding: 14,
    color: colors.text,
    marginVertical: 8,
  };
  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{
        padding: 24,
        paddingTop: 65,
        gap: 16,
        backgroundColor: colors.bg,
        flexGrow: 1,
      }}
    >
      <Pressable onPress={onClose}>
        <Text style={{ color: colors.gold2 }}>Back</Text>
      </Pressable>
      <Text style={{ fontSize: 28, fontWeight: "700", color: colors.text }}>
        Account security
      </Text>
      {!!error && (
        <Text style={{ color: colors.red }} accessibilityRole="alert">
          {error}
        </Text>
      )}
      {state && (
        <>
          <Text style={{ color: colors.muted }}>
            {state.mfaEnabled
              ? `Authenticator enabled · ${state.recoveryCodesRemaining} recovery codes remaining`
              : state.mfaRequired
                ? "Set up an authenticator before opening your workspace."
                : "Add an authenticator to protect your account."}
          </Text>
          {!state.mfaEnabled && !recovery.length && !secret && (
            <View>
              <Text style={{ color: colors.text }}>Current password</Text>
              <TextInput
                accessibilityLabel="Current password"
                secureTextEntry
                autoComplete="current-password"
                value={password}
                onChangeText={setPassword}
                style={input}
              />
              <PrimaryButton
                title="Set up authenticator"
                disabled={busy || !password}
                onPress={() =>
                  run(async () => {
                    const r = await request<{ secret: string }>("/mfa/setup", {
                      password,
                    });
                    setSecret(r.secret);
                    setPassword("");
                  })
                }
              />
            </View>
          )}
          {!!secret && !recovery.length && (
            <View>
              <Text style={{ color: colors.text }}>
                Add this key to your authenticator as a time-based DarkLion
                account:
              </Text>
              <Text
                selectable
                style={{ color: colors.gold2, paddingVertical: 16 }}
              >
                {secret}
              </Text>
              <TextInput
                accessibilityLabel="Authenticator code"
                keyboardType="number-pad"
                autoComplete="one-time-code"
                value={code}
                onChangeText={setCode}
                style={input}
              />
              <PrimaryButton
                title="Verify and enable"
                disabled={busy || !code}
                onPress={() =>
                  run(async () => {
                    const r = await request<{ recoveryCodes: string[] }>(
                      "/mfa/enable",
                      { code },
                    );
                    setRecovery(r.recoveryCodes);
                    setSecret("");
                  })
                }
              />
            </View>
          )}
          {!!recovery.length && (
            <>
              <Text style={{ color: colors.text }}>
                Save these recovery codes in a private place. Each works once if
                you lose access to your authenticator.
              </Text>
              <Text selectable style={{ color: colors.gold2, lineHeight: 26 }}>
                {recovery.join("\n")}
              </Text>
              <PrimaryButton
                title="I saved my codes · Sign in again"
                onPress={onSignOut}
              />
            </>
          )}
          {!recovery.length && (
            <>
              <Text style={{ fontSize: 20, color: colors.text }}>Devices</Text>
              {state.sessions.map((s) => (
                <View
                  key={s.id}
                  style={{
                    paddingVertical: 10,
                    borderBottomWidth: 1,
                    borderBottomColor: "#ffffff20",
                  }}
                >
                  <Text style={{ color: colors.text }}>
                    {s.device_label || "Signed-in device"}
                    {s.id === state.currentSessionId ? " · This session" : ""}
                  </Text>
                  <Text style={{ color: colors.muted }}>
                    {new Date(s.created_at).toLocaleString()}
                  </Text>
                  <Pressable
                    disabled={busy}
                    onPress={() =>
                      run(async () => {
                        await apiFetch(
                          base + "/sessions/" + s.id,
                          { method: "DELETE" },
                          token,
                        );
                        if (s.id === state.currentSessionId) onSignOut();
                        else await load();
                      })
                    }
                  >
                    <Text style={{ color: colors.gold2, paddingVertical: 10 }}>
                      Sign out device
                    </Text>
                  </Pressable>
                </View>
              ))}
              <PrimaryButton
                title="Sign out all devices"
                disabled={busy}
                onPress={() =>
                  run(async () => {
                    await request("/sessions/revoke-all", {});
                    onSignOut();
                  })
                }
              />
              <Text style={{ fontSize: 20, color: colors.text, marginTop: 16 }}>
                Your information
              </Text>
              <Text style={{ color: colors.muted }}>
                Your firm reviews export and deletion requests, including any
                records it must retain.
              </Text>
              <TextInput
                accessibilityLabel="Request details"
                placeholder="Additional details (optional)"
                placeholderTextColor={colors.muted}
                value={note}
                onChangeText={setNote}
                multiline
                maxLength={1000}
                style={input}
              />
              {(["export", "deletion"] as const).map((kind) => (
                <PrimaryButton
                  key={kind}
                  title={
                    kind === "export"
                      ? "Request a copy of my information"
                      : "Request account deletion"
                  }
                  disabled={busy}
                  onPress={() =>
                    Alert.alert(
                      kind === "export"
                        ? "Request your information?"
                        : "Request account deletion?",
                      "Your firm will review this request.",
                      [
                        { text: "Cancel", style: "cancel" },
                        {
                          text: "Submit request",
                          onPress: () =>
                            run(async () => {
                              await request("/data-requests", { kind, note });
                              Alert.alert(
                                "Request submitted",
                                "Your firm will review your request.",
                              );
                            }),
                        },
                      ],
                    )
                  }
                />
              ))}
            </>
          )}
        </>
      )}
    </ScrollView>
  );
}
