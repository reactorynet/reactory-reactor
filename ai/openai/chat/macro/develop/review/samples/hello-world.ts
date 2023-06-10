/**
 * Hello world application
 */

const messages: { 
  [key: string]: {
    hello: string
  }
 } = {
  "af-za": {
    hello: 'Hallo Wêreld!',
  },
  "ar-ae": {
    hello: 'مرحبا بالعالم!',
  },
  "ar-bh": {
    hello: 'مرحبا بالعالم!',
  },
  "en-us": {
    hello: 'Hello World!',
  },
  "en-gb": {
    hello: 'Hello World!',
  },
}

/**
 * Main function for the application
 * @param args 
 */
function main(args: string[]) {
  const [lang] = args;
  const message: string = messages[lang] ? messages[lang].hello : messages['en-us'].hello;
  console.log(message);
  process.exit(0);
}

export default main;