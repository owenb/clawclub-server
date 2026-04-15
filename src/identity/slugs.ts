export const SLUG_PATTERN = '[a-z0-9]+(?:-[a-z0-9]+)*';

export const SLUG_REGEX = new RegExp(`^${SLUG_PATTERN}$`);
