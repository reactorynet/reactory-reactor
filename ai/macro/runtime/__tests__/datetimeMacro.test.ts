import { DateTimeMacro } from '../datetimeMacro.macro';
import { createMockState } from './support/mockState';

describe('DateTimeMacro', () => {
  describe('format: iso (default)', () => {
    it('should return current date in ISO format by default', async () => {
      const state = createMockState();
      const result: any = await DateTimeMacro({}, state);

      expect(result.success).toBe(true);
      expect(result.format).toBe('iso');
      // ISO string matches pattern
      expect(result.result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
  });

  describe('format: unix', () => {
    it('should return a numeric unix timestamp string', async () => {
      const state = createMockState();
      const result: any = await DateTimeMacro({ format: 'unix' }, state);

      expect(result.success).toBe(true);
      expect(Number(result.result)).not.toBeNaN();
    });
  });

  describe('format: unix-ms', () => {
    it('should return millisecond timestamp', async () => {
      const state = createMockState();
      const result: any = await DateTimeMacro({ format: 'unix-ms' }, state);

      expect(result.success).toBe(true);
      const ms = Number(result.result);
      expect(ms).toBeGreaterThan(1_000_000_000_000);
    });
  });

  describe('format: yyyy-mm-dd', () => {
    it('should return date-only string', async () => {
      const state = createMockState();
      const result: any = await DateTimeMacro(
        { format: 'yyyy-mm-dd', date: '2025-06-15T12:00:00Z', timezone: 'utc' },
        state,
      );

      expect(result.success).toBe(true);
      expect(result.result).toBe('2025-06-15');
    });
  });

  describe('format: json', () => {
    it('should return a parseable JSON object with date components', async () => {
      const state = createMockState();
      const result: any = await DateTimeMacro({ format: 'json' }, state);

      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.result);
      expect(parsed).toHaveProperty('year');
      expect(parsed).toHaveProperty('month');
      expect(parsed).toHaveProperty('day');
      expect(parsed).toHaveProperty('iso');
      expect(parsed).toHaveProperty('unix');
    });
  });

  describe('date parameter parsing', () => {
    it('should handle "today" keyword', async () => {
      const state = createMockState();
      const result: any = await DateTimeMacro({ date: 'today', format: 'yyyy-mm-dd', timezone: 'utc' }, state);

      expect(result.success).toBe(true);
      // "today" returns the current date portion regardless of timezone offset
      const todayStr = new Date().toISOString().split('T')[0];
      // Allow for 1-day offset due to UTC conversion near midnight
      const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
      expect([todayStr, yesterday]).toContain(result.result);
    });

    it('should parse an explicit date string', async () => {
      const state = createMockState();
      const result: any = await DateTimeMacro(
        { date: '2024-12-25T10:30:00Z', format: 'yyyy-mm-dd', timezone: 'utc' },
        state,
      );

      expect(result.success).toBe(true);
      expect(result.result).toBe('2024-12-25');
    });

    it('should return an error for an invalid date', async () => {
      const state = createMockState();
      const result: any = await DateTimeMacro({ date: 'not-a-date' }, state);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid date');
    });
  });

  describe('targetVariable', () => {
    it('should store the formatted date in a state variable', async () => {
      const state = createMockState();
      const result: any = await DateTimeMacro(
        { format: 'unix', targetVariable: 'myTime' },
        state,
      );

      expect(result.success).toBe(true);
      expect(result.storedVariable).toBe('myTime');
      expect(state.vars.myTime).toBeDefined();
    });
  });
});
