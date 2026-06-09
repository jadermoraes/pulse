import { describe, it, expect } from 'vitest';
import {
  validateDisplayName,
  validateUsername,
  validatePassword,
  validateOnboarding
} from './validate';

describe('validateDisplayName', () => {
  it('accepts a normal name', () => expect(validateDisplayName('Ada Lovelace')).toBeNull());
  it('rejects empty / whitespace', () => {
    expect(validateDisplayName('')).not.toBeNull();
    expect(validateDisplayName('   ')).not.toBeNull();
  });
  it('rejects over-long names', () => expect(validateDisplayName('x'.repeat(65))).not.toBeNull());
});

describe('validateUsername', () => {
  it('accepts valid usernames', () => {
    for (const u of ['ada', 'ada_lovelace', 'user.name-1', 'AB3']) expect(validateUsername(u)).toBeNull();
  });
  it('rejects too short', () => expect(validateUsername('ab')).not.toBeNull());
  it('rejects too long', () => expect(validateUsername('a'.repeat(33))).not.toBeNull());
  it('rejects spaces and exotic chars', () => {
    for (const u of ['has space', 'bad!', 'with/slash', 'emoji😀x']) expect(validateUsername(u)).not.toBeNull();
  });
  it('rejects leading/trailing punctuation', () => {
    expect(validateUsername('.ada')).not.toBeNull();
    expect(validateUsername('ada_')).not.toBeNull();
  });
});

describe('validatePassword', () => {
  it('accepts an 8+ char password', () => expect(validatePassword('hunter22')).toBeNull());
  it('rejects too short', () => expect(validatePassword('short')).not.toBeNull());
  it('rejects too long', () => expect(validatePassword('x'.repeat(129))).not.toBeNull());
  it('rejects all-whitespace', () => expect(validatePassword('         ')).not.toBeNull());
  it('rejects password equal to username (case-insensitive)', () => {
    expect(validatePassword('AdaLovelace', 'adalovelace')).not.toBeNull();
  });
});

describe('validateOnboarding', () => {
  it('returns null when all fields are valid', () => {
    expect(validateOnboarding({ displayName: 'Ada', username: 'ada_l', password: 'hunter22' })).toBeNull();
  });
  it('surfaces the first failing field', () => {
    expect(validateOnboarding({ displayName: '', username: 'ada_l', password: 'hunter22' })).not.toBeNull();
    expect(validateOnboarding({ displayName: 'Ada', username: 'a', password: 'hunter22' })).not.toBeNull();
    expect(validateOnboarding({ displayName: 'Ada', username: 'ada_l', password: 'x' })).not.toBeNull();
  });
});
