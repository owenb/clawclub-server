export type ClubTextState = {
  name: string;
  summary: string | null;
  admissionPolicy: string | null;
};

export type ClubTextPatch = {
  name?: string;
  summary?: string | null;
  admissionPolicy?: string | null;
};

export function mergeClubTextPatch(
  current: ClubTextState,
  patch: ClubTextPatch,
): ClubTextState {
  return {
    name: patch.name !== undefined ? patch.name : current.name,
    summary: patch.summary !== undefined ? patch.summary : current.summary,
    admissionPolicy: patch.admissionPolicy !== undefined ? patch.admissionPolicy : current.admissionPolicy,
  };
}

export function clubTextPatchTouchesFields(patch: ClubTextPatch): boolean {
  return patch.name !== undefined || patch.summary !== undefined || patch.admissionPolicy !== undefined;
}

function textFieldSkipsGate(current: string | null, next: string | null | undefined): boolean {
  if (next === undefined) return true;
  if (next === current) return true;
  return next === null;
}

export function clubTextPatchSkipsGate(
  current: ClubTextState,
  patch: ClubTextPatch,
): boolean {
  if (patch.name !== undefined && patch.name !== current.name) {
    return false;
  }
  return textFieldSkipsGate(current.summary, patch.summary)
    && textFieldSkipsGate(current.admissionPolicy, patch.admissionPolicy);
}
