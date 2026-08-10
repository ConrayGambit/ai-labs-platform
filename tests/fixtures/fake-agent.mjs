if (process.argv[2] === 'json-result') {
  process.stdout.write(JSON.stringify({ result: 'Structured final answer' }));
} else {
  const payload = {
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    env: {
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL ?? null,
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN ?? null,
      MISSING_REFERENCE: process.env.MISSING_REFERENCE ?? null,
    },
    stdin: await new Promise((resolve) => {
      let value = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        value += chunk;
      });
      process.stdin.on('end', () => resolve(value));
    }),
  };

  process.stdout.write(JSON.stringify(payload));
}
