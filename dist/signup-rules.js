// Unicode mode counts each code point once, including characters outside the BMP.
const signupLength = /^.{1,8}$/su;
const blockedUsernameStart = /^[pP\p{Decimal_Number}]/u;

export function signupRules(username, password) {
  const name = typeof username === 'string' ? username.trim() : '';
  let usernameError = '';
  if (!signupLength.test(name)) {
    usernameError = 'Username must contain 1–8 characters.';
  } else if (blockedUsernameStart.test(name)) {
    usernameError = 'Username cannot start with a number or the letter P.';
  }

  return {
    username: usernameError,
    password: typeof password === 'string' && signupLength.test(password)
      ? '' : 'Password must contain 1–8 characters.'
  };
}
