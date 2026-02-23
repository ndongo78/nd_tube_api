const search = require('./youtubeSearch');

const args = process.argv.slice(2);
const options = {};
const terms = [];

for (const arg of args) {
  if (arg.startsWith('--limit=')) {
    options.limit = Number(arg.slice('--limit='.length));
  } else if (arg.startsWith('--type=')) {
    options.type = arg.slice('--type='.length);
  } else if (arg.startsWith('--hl=')) {
    options.hl = arg.slice('--hl='.length);
  } else if (arg.startsWith('--gl=')) {
    options.gl = arg.slice('--gl='.length);
  } else {
    terms.push(arg);
  }
}

const query = terms.join(' ').trim();

if (!query) {
  console.error('Usage: npm start -- "<search query>" [--type=video|playlist|channel|all] [--limit=10] [--hl=fr] [--gl=FR]');
  process.exit(1);
}

search(query, options)
  .then(result => {
    console.log(JSON.stringify(result, null, 2));
  })
  .catch(error => {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  });
