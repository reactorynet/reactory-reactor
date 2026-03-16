import Reactory from "@reactorynet/reactory-core";
import { ChatState, Macro, MacroComponentDefinition } from "../../../types/chat";
import { DateTimeMacroProps } from './types';

// a macro that provides date and time functionality with format options
export const DateTimeMacro: Macro<unknown, DateTimeMacroProps> = async (
  props: DateTimeMacroProps,
  state: ChatState): Promise<unknown> => {
  
  const { 
    format = 'iso', 
    timezone = 'local', 
    date = 'now',
    targetVariable 
  } = props;
  
  try {
    let dateObj: Date;

    // Parse the date parameter
    if (date === 'now' || date === 'current') {
      dateObj = new Date();
    } else if (date === 'today') {
      dateObj = new Date();
      dateObj.setHours(0, 0, 0, 0);
    } else if (date === 'yesterday') {
      dateObj = new Date();
      dateObj.setDate(dateObj.getDate() - 1);
      dateObj.setHours(0, 0, 0, 0);
    } else if (date === 'tomorrow') {
      dateObj = new Date();
      dateObj.setDate(dateObj.getDate() + 1);
      dateObj.setHours(0, 0, 0, 0);
    } else {
      // Try to parse as a date string or timestamp
      const parsed = new Date(date);
      if (isNaN(parsed.getTime())) {
        return {
          error: `Invalid date format: ${date}`,
          success: false
        };
      }
      dateObj = parsed;
    }

    // Apply timezone if specified
    if (timezone !== 'local') {
      // For now, we'll use UTC. In a full implementation, you might want to use a library like moment-timezone
      if (timezone === 'utc') {
        dateObj = new Date(dateObj.toISOString());
      } else {
        // Try to parse as offset (e.g., "+05:30", "-08:00")
        const offsetMatch = timezone.match(/^([+-])(\d{1,2}):(\d{2})$/);
        if (offsetMatch) {
          const [, sign, hours, minutes] = offsetMatch;
          const offsetMs = (parseInt(hours) * 60 + parseInt(minutes)) * 60 * 1000;
          if (sign === '-') {
            dateObj = new Date(dateObj.getTime() - offsetMs);
          } else {
            dateObj = new Date(dateObj.getTime() + offsetMs);
          }
        }
      }
    }

    let formattedDate: string;

    // Format the date based on the format parameter
    switch (format.toLowerCase()) {
      case 'iso':
        formattedDate = dateObj.toISOString();
        break;
      case 'iso-local':
        formattedDate = dateObj.toLocaleString();
        break;
      case 'date':
        formattedDate = dateObj.toDateString();
        break;
      case 'time':
        formattedDate = dateObj.toTimeString();
        break;
      case 'locale':
        formattedDate = dateObj.toLocaleString();
        break;
      case 'locale-date':
        formattedDate = dateObj.toLocaleDateString();
        break;
      case 'locale-time':
        formattedDate = dateObj.toLocaleTimeString();
        break;
      case 'unix':
        formattedDate = Math.floor(dateObj.getTime() / 1000).toString();
        break;
      case 'unix-ms':
        formattedDate = dateObj.getTime().toString();
        break;
      case 'rfc2822':
        formattedDate = dateObj.toUTCString();
        break;
      case 'yyyy-mm-dd':
        formattedDate = dateObj.toISOString().split('T')[0];
        break;
      case 'mm/dd/yyyy':
        const month = (dateObj.getMonth() + 1).toString().padStart(2, '0');
        const day = dateObj.getDate().toString().padStart(2, '0');
        const year = dateObj.getFullYear();
        formattedDate = `${month}/${day}/${year}`;
        break;
      case 'dd/mm/yyyy':
        const day2 = dateObj.getDate().toString().padStart(2, '0');
        const month2 = (dateObj.getMonth() + 1).toString().padStart(2, '0');
        const year2 = dateObj.getFullYear();
        formattedDate = `${day2}/${month2}/${year2}`;
        break;
      case 'hh:mm:ss':
        const hours = dateObj.getHours().toString().padStart(2, '0');
        const minutes = dateObj.getMinutes().toString().padStart(2, '0');
        const seconds = dateObj.getSeconds().toString().padStart(2, '0');
        formattedDate = `${hours}:${minutes}:${seconds}`;
        break;
      case 'hh:mm':
        const hours2 = dateObj.getHours().toString().padStart(2, '0');
        const minutes2 = dateObj.getMinutes().toString().padStart(2, '0');
        formattedDate = `${hours2}:${minutes2}`;
        break;
      case '12h':
        const hours12 = dateObj.getHours();
        const ampm = hours12 >= 12 ? 'PM' : 'AM';
        const hours12Formatted = (hours12 % 12 || 12).toString().padStart(2, '0');
        const minutes12 = dateObj.getMinutes().toString().padStart(2, '0');
        formattedDate = `${hours12Formatted}:${minutes12} ${ampm}`;
        break;
      case 'relative':
        formattedDate = getRelativeTime(dateObj);
        break;
      case 'json':
        formattedDate = JSON.stringify({
          iso: dateObj.toISOString(),
          unix: Math.floor(dateObj.getTime() / 1000),
          unixMs: dateObj.getTime(),
          year: dateObj.getFullYear(),
          month: dateObj.getMonth() + 1,
          day: dateObj.getDate(),
          hours: dateObj.getHours(),
          minutes: dateObj.getMinutes(),
          seconds: dateObj.getSeconds(),
          milliseconds: dateObj.getMilliseconds(),
          timezone: timezone,
          dayOfWeek: dateObj.getDay(),
          dayOfYear: Math.floor((dateObj.getTime() - new Date(dateObj.getFullYear(), 0, 0).getTime()) / (1000 * 60 * 60 * 24))
        });
        break;
      default:
        // Try to use the format as a custom format string
        try {
          formattedDate = formatCustomDate(dateObj, format);
        } catch (error) {
          return {
            error: `Unknown format '${format}'. Available formats: iso, iso-local, date, time, locale, locale-date, locale-time, unix, unix-ms, rfc2822, yyyy-mm-dd, mm/dd/yyyy, dd/mm/yyyy, hh:mm:ss, hh:mm, 12h, relative, json`,
            success: false
          };
        }
    }

    // Store result in target variable if specified, otherwise return it
    if (targetVariable && state && state.vars) {
      if (!state.vars) {
        state.vars = {};
      }
      state.vars[targetVariable] = formattedDate;
      return {
        result: `Date/time stored in variable '${targetVariable}': ${formattedDate}`,
        success: true,
        storedVariable: targetVariable,
        value: formattedDate,
        instructions: `## Date/Time Stored\n\nStored in variable **${targetVariable}**: ${formattedDate}\n\n### Available Data:\n- **value**: "${formattedDate}"\n- **storedVariable**: "${targetVariable}"\n\n### Suggested Next Steps:\n- Use \`var\` with key="${targetVariable}" to retrieve this value later\n- Use \`datetime\` with a different format to get an alternative representation`
      };
    } else {
      // Return structured response for Google API compatibility
      return {
        result: formattedDate,
        success: true,
        format: format,
        timezone: timezone,
        date: date,
        timestamp: dateObj.getTime(),
        iso: dateObj.toISOString(),
        instructions: `## Date/Time Result\n\n**${formattedDate}** (format: ${format}, timezone: ${timezone})\n\n### Available Data:\n- **result**: Formatted date string\n- **timestamp**: Unix timestamp in milliseconds (${dateObj.getTime()})\n- **iso**: ISO 8601 representation (${dateObj.toISOString()})\n\n### Available Formats:\niso, date, time, locale, unix, unix-ms, rfc2822, yyyy-mm-dd, mm/dd/yyyy, dd/mm/yyyy, hh:mm:ss, hh:mm, 12h, relative, json\n\n### Suggested Next Steps:\n- Use \`datetime\` with targetVariable to store the result\n- Use \`datetime\` with format="json" to get all date components\n- Use \`var\` to store the result manually`
      };
    }

  } catch (err) {
    return {
      error: `Error in datetime macro: ${err instanceof Error ? err.message : 'Unknown error'}`,
      success: false
    };
  }
};

// Helper function to get relative time (e.g., "2 hours ago", "in 3 days")
function getRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (Math.abs(diffSeconds) < 60) {
    return diffSeconds === 0 ? 'now' : `${Math.abs(diffSeconds)} seconds ${diffSeconds > 0 ? 'from now' : 'ago'}`;
  } else if (Math.abs(diffMinutes) < 60) {
    return `${Math.abs(diffMinutes)} minute${Math.abs(diffMinutes) !== 1 ? 's' : ''} ${diffMinutes > 0 ? 'from now' : 'ago'}`;
  } else if (Math.abs(diffHours) < 24) {
    return `${Math.abs(diffHours)} hour${Math.abs(diffHours) !== 1 ? 's' : ''} ${diffHours > 0 ? 'from now' : 'ago'}`;
  } else if (Math.abs(diffDays) < 7) {
    return `${Math.abs(diffDays)} day${Math.abs(diffDays) !== 1 ? 's' : ''} ${diffDays > 0 ? 'from now' : 'ago'}`;
  } else {
    return date.toLocaleDateString();
  }
}

// Helper function to format custom date strings
function formatCustomDate(date: Date, format: string): string {
  const replacements: Record<string, string> = {
    'yyyy': date.getFullYear().toString(),
    'yy': date.getFullYear().toString().slice(-2),
    'MM': (date.getMonth() + 1).toString().padStart(2, '0'),
    'M': (date.getMonth() + 1).toString(),
    'dd': date.getDate().toString().padStart(2, '0'),
    'd': date.getDate().toString(),
    'HH': date.getHours().toString().padStart(2, '0'),
    'H': date.getHours().toString(),
    'hh': (date.getHours() % 12 || 12).toString().padStart(2, '0'),
    'h': (date.getHours() % 12 || 12).toString(),
    'mm': date.getMinutes().toString().padStart(2, '0'),
    'm': date.getMinutes().toString(),
    'ss': date.getSeconds().toString().padStart(2, '0'),
    's': date.getSeconds().toString(),
    'SSS': date.getMilliseconds().toString().padStart(3, '0'),
    'A': date.getHours() >= 12 ? 'PM' : 'AM',
    'a': date.getHours() >= 12 ? 'pm' : 'am'
  };

  let result = format;
  for (const [pattern, replacement] of Object.entries(replacements)) {
    result = result.replace(new RegExp(pattern, 'g'), replacement);
  }

  return result;
}

export const DateTimeMacroRegistry: MacroComponentDefinition<typeof DateTimeMacro> = {
  nameSpace: 'reactor-macros',
  name: 'datetime',
  version: '1.0.0',
  alias: 'datetime',
  component: DateTimeMacro,
  roles: ['ADMIN', 'DEVELOPER', 'USER'],
  description: `# datetime macro
  Use this macro to get formatted date and time information
  
  ## Usage
  @datetime() - returns current date/time in ISO format
  @datetime(format) - returns current date/time in specified format
  @datetime(format, date) - returns specified date in specified format
  @datetime(format, date, timezone) - returns date in timezone with format
  @datetime(format, date, timezone, targetVariable) - stores result in variable
  
  ## Date Parameters
  - 'now' or 'current' - current date/time
  - 'today' - start of today
  - 'yesterday' - start of yesterday
  - 'tomorrow' - start of tomorrow
  - ISO date string - '2023-12-25T10:30:00Z'
  - Unix timestamp - '1703507400000'
  
  ## Format Options
  - 'iso' - ISO 8601 format (2023-12-25T10:30:00.000Z)
  - 'iso-local' - ISO format in local timezone
  - 'date' - Date string (Mon Dec 25 2023)
  - 'time' - Time string (10:30:00 GMT+0000)
  - 'locale' - Localized date and time
  - 'locale-date' - Localized date only
  - 'locale-time' - Localized time only
  - 'unix' - Unix timestamp (seconds)
  - 'unix-ms' - Unix timestamp (milliseconds)
  - 'rfc2822' - RFC 2822 format
  - 'yyyy-mm-dd' - Date only (2023-12-25)
  - 'mm/dd/yyyy' - US date format (12/25/2023)
  - 'dd/mm/yyyy' - European date format (25/12/2023)
  - 'hh:mm:ss' - 24-hour time (10:30:00)
  - 'hh:mm' - 24-hour time short (10:30)
  - '12h' - 12-hour time (10:30 AM)
  - 'relative' - Relative time (2 hours ago)
  - 'json' - JSON object with all date components
  
  ## Custom Formats
  Use format strings like:
  - 'yyyy-MM-dd HH:mm:ss' - 2023-12-25 10:30:00
  - 'MM/dd/yyyy hh:mm A' - 12/25/2023 10:30 AM
  - 'dd MMM yyyy' - 25 Dec 2023
  
  ## Timezone Options
  - 'local' - Local timezone (default)
  - 'utc' - UTC timezone
  - '+05:30' - UTC+5:30
  - '-08:00' - UTC-8:00
  
  ## Examples
  - @datetime() - Current time in ISO format
  - @datetime('yyyy-mm-dd') - Today's date
  - @datetime('12h', 'tomorrow') - Tomorrow in 12-hour format
  - @datetime('unix', '2023-12-25') - Christmas 2023 as Unix timestamp
  - @datetime('json', 'now', 'utc', 'currentTime') - Store current UTC time as JSON
  `,
  features: [
    {
      feature: 'datetime',
      featureType: Reactory.FeatureType.function,
      action: ['get', 'format', 'convert', 'display'],
      description: 'Operation that provides formatted date and time information.',
      stem: 'datetime'
    }
  ],
  stem: 'datetime',
  tags: ['datetime', 'date', 'time', 'format', 'timestamp'],
  tools: [{
    type: "function",
    function: {
      name: "datetime",
      description: "Get formatted date and time information",
      parameters: {
        type: "object",
        properties: {
          format: {
            type: "string",
            description: "The format for the date/time output (iso, date, time, locale, unix, etc.)",
            enum: ["iso", "iso-local", "date", "time", "locale", "locale-date", "locale-time", "unix", "unix-ms", "rfc2822", "yyyy-mm-dd", "mm/dd/yyyy", "dd/mm/yyyy", "hh:mm:ss", "hh:mm", "12h", "relative", "json"]
          },
          timezone: {
            type: "string",
            description: "The timezone to use (local, utc, or offset like +05:30, -08:00)"
          },
          date: {
            type: "string",
            description: "The date to format (now, today, yesterday, tomorrow, or date string)"
          },
          targetVariable: {
            type: "string",
            description: "Optional target variable name to store the formatted date/time"
          }
        },
        required: []
      }
    }
  }]
} 