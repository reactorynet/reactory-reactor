import crypto from 'crypto';

/**
 * Checks if the response is a help request.
 * @param response 
 * @returns 
 */
export const isHelpRequest = (response: string): boolean => response.charAt(0) === '?'.charAt(0);

/**
 * Generates a strong random string.
 * @returns 
 */
export const strongRandom = () => {
  const randomBytes = crypto.randomBytes(32);
  const base64String = randomBytes.toString('base64');

  return base64String;
}

/**
 * Removes all ANSI color codes from a string.
 * @param input 
 * @returns 
 */
export const stripColorCodes = (input: string): string => {
  const ansiColorRegex = /\x1b\[[0-9;]*m/g; // matches any ANSI color code sequence
  return input.replace(ansiColorRegex, ''); // remove all matched sequences
}
