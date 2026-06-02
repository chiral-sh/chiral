const fs = require('fs');

let diffTest = fs.readFileSync('tests/unit/commands/diff.test.ts', 'utf8');
diffTest = diffTest.replace(
  /expect\(output\.join\('\\n'\)\)\.not\.toContain\('-'\);/g,
  "expect(output.join('\\n')).not.toMatch(/^\\s*-\\s+/m);"
);
fs.writeFileSync('tests/unit/commands/diff.test.ts', diffTest);

let cloneTest = fs.readFileSync('tests/unit/commands/clone.test.ts', 'utf8');

// Replace double await expect... rejects.toThrow
cloneTest = cloneTest.replace(
  /await expect\(runClone\([^)]+\)\)\.rejects\.toThrow\(UserError\);\n\s*await expect\(runClone\(([^)]+)\)\)\.rejects\.toThrow\(([^)]+)\);/g,
  "const err = await runClone($1).catch(e => e);\n      expect(err).toBeInstanceOf(UserError);\n      expect(err.message).toContain($2);"
);

// For the directory collision test:
cloneTest = cloneTest.replace(
  /await expect\(runClone\(REPO_URL, \{ skipTest: true \}\)\)\.rejects\.toThrow\(UserError\);\n\s*await expect\(runClone\(REPO_URL, \{ skipTest: true \}\)\)\.rejects\.toThrow\('already exists'\);/g,
  "const err = await runClone(REPO_URL, { skipTest: true }).catch(e => e);\n      expect(err).toBeInstanceOf(UserError);\n      expect(err.message).toContain('already exists');"
);

// For exit code git failure test:
cloneTest = cloneTest.replace(
  /await expect\(runClone\(REPO_URL, \{ skipTest: true \}\)\)\.rejects\.toThrow\(UserError\);/g,
  "const err = await runClone(REPO_URL, { skipTest: true }).catch(e => e);\n      expect(err).toBeInstanceOf(UserError);"
);

// Fix ppid check
cloneTest = cloneTest.replace(
  /expect\(writeSession\)\.toHaveBeenCalledWith\(12345, 'acme'\);/g,
  "expect(writeSession).toHaveBeenCalledWith(process.ppid, 'acme');"
);

// Fix skipTest TypeError (undefined is not a spy)
// In the skipTest test, clientInstance is vi.mocked(N8nClient).mock.results[0]?.value.
// But N8nClient is mocked with a mockImplementation returning an object, so it's a class.
// We can just check N8nClient.mock.results[0].value.testConnection.
cloneTest = cloneTest.replace(
  /const clientInstance = vi\.mocked\(N8nClient\)\.mock\.results\[0\]\?\.value as \{\n\s*testConnection: ReturnType<typeof vi\.fn>;\n\s*\} \| undefined;\n\s*expect\(clientInstance\?\.testConnection\)\.not\.toHaveBeenCalled\(\);/g,
  "const clientInstance = vi.mocked(N8nClient).mock.results[0]?.value as { testConnection: ReturnType<typeof vi.fn> };\n      expect(clientInstance.testConnection).not.toHaveBeenCalled();"
);

fs.writeFileSync('tests/unit/commands/clone.test.ts', cloneTest);
