import crypto from 'crypto';
import { getSettingValue, setSettingValue } from './db';

// The admin account is created on first access to the panel and stored in
// the settings table (never in the environment). The password is hashed
// with scrypt plus a random per-account salt.
const KEY_USERNAME = 'ADMIN_USERNAME';
const KEY_HASH = 'ADMIN_HASH';
const SCRYPT_KEYLEN = 64;

export function isAdminConfigured(): boolean {
  return Boolean(getSettingValue(KEY_HASH));
}

export interface SetupError {
  field: string;
  message: string;
}

export function createAdminAccount(username: unknown, password: unknown): SetupError[] {
  const errors: SetupError[] = [];
  const user = typeof username === 'string' ? username.trim() : '';
  const pass = typeof password === 'string' ? password : '';
  if (user.length < 3 || user.length > 64) {
    errors.push({ field: 'username', message: 'Username must be 3-64 characters' });
  }
  if (pass.length < 8 || pass.length > 200) {
    errors.push({ field: 'password', message: 'Password must be 8-200 characters' });
  }
  if (errors.length > 0) return errors;

  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pass, salt, SCRYPT_KEYLEN).toString('hex');
  setSettingValue(KEY_USERNAME, user);
  setSettingValue(KEY_HASH, `${salt}$${hash}`);
  return [];
}

export function verifyAdmin(username: unknown, password: unknown): boolean {
  if (typeof username !== 'string' || typeof password !== 'string') return false;
  const storedUser = getSettingValue(KEY_USERNAME);
  const storedHash = getSettingValue(KEY_HASH);
  if (!storedHash || !storedUser) return false;

  const [salt, hash] = storedHash.split('$');
  if (!salt || !hash) return false;

  // Compare the username in constant time as well.
  const userA = crypto.createHash('sha256').update(username).digest();
  const userB = crypto.createHash('sha256').update(storedUser).digest();
  if (!crypto.timingSafeEqual(userA, userB)) return false;

  const given = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  const expected = Buffer.from(hash, 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}
