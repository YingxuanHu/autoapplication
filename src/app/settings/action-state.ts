export type SettingsActionState = {
  error: string | null;
  success: string | null;
};

export const initialSettingsState: SettingsActionState = {
  error: null,
  success: null,
};
