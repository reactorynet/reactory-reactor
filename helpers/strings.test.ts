import { isHelpRequest, strongRandom, stripColorCodes } from './strings';

// Unit tests for isHelpRequest function
describe('isHelpRequest function', () => {
  it('returns true when the response starts with a "?" character', () => {
    const response = '?help';
    expect(isHelpRequest(response)).toBe(true);
  });

  it('returns false when the response does not start with a "?" character', () => {
    const response = 'help';
    expect(isHelpRequest(response)).toBe(false);
  });
});

// Unit tests for strongRandom function
describe('strongRandom function', () => {
  it('returns a string', () => {
    const result = strongRandom();
    expect(typeof result).toBe('string');
  });

  it('returns a string with length 44', () => {
    const result = strongRandom();
    expect(result.length).toBe(44);
  });
});

// Unit tests for stripColorCodes function
describe('stripColorCodes function', () => {
  it('removes all ANSI color codes from the input string', () => {
    const input = '\u001b[31mHello world!\u001b[0m';
    const result = stripColorCodes(input);
    expect(result).toBe('Hello world!');
  });

  it('does not modify the input string if it does not contain any ANSI color codes', () => {
    const input = 'Hello world!';
    const result = stripColorCodes(input);
    expect(result).toBe('Hello world!');
  });
});
