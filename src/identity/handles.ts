export const HANDLE_PATTERN = '[a-z0-9]+(?:-[a-z0-9]+)*';

export const HANDLE_REGEX = new RegExp(`^${HANDLE_PATTERN}$`);
