export type ProfileNoticeKind = "error" | "info";

interface ProfileNoticeState {
  kind: ProfileNoticeKind;
  message: string | null;
}

export const profileNotice = $state<ProfileNoticeState>({
  kind: "info",
  message: null,
});

export function showProfileNotice(message: string, kind: ProfileNoticeKind = "info"): void {
  profileNotice.kind = kind;
  profileNotice.message = message;
}

export function dismissProfileNotice(): void {
  profileNotice.message = null;
}
