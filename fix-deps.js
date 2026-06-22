const fs = require('fs');
const path = require('path');

const VERSIONS = {
  '@aerograph/contracts': '0.3.0',
  '@aerograph/sdk': '0.3.0',
  '@aerograph/adapter-langchain': '0.3.0',
  '@aerograph/schema-exporter': '0.3.0',
  '@aerograph/otel': '0.2.0'
};

function walk(dir) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    if (fs.statSync(fullPath).isDirectory() && file !== 'node_modules' && !fullPath.includes('.git')) {
      walk(fullPath);
    } else if (file === 'package.json') {
      let content = fs.readFileSync(fullPath, 'utf8');
      let changed = false;
      const json = JSON.parse(content);
      for (const deps of ['dependencies', 'devDependencies', 'peerDependencies']) {
        if (json[deps]) {
          for (const [pkg, ver] of Object.entries(VERSIONS)) {
            if (json[deps][pkg]) {
              json[deps][pkg] = ver;
              changed = true;
            }
          }
        }
      }
      if (changed) {
        fs.writeFileSync(fullPath, JSON.stringify(json, null, 2) + '\n');
        console.log('Fixed dependencies in', fullPath);
      }
    }
  }
}

walk('.');
