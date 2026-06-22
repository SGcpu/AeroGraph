const fs = require('fs');
const path = require('path');

function walk(dir) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    if (fs.statSync(fullPath).isDirectory() && file !== 'node_modules') {
      walk(fullPath);
    } else if (file === 'package.json') {
      let content = fs.readFileSync(fullPath, 'utf8');
      if (content.includes('\\"*\\"')) {
        fs.writeFileSync(fullPath, content.replace(/\\"\*\\"/g, '"*"'));
        console.log('Fixed', fullPath);
      }
    }
  }
}

walk('.');
