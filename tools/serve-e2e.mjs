/**
 * Serves the production build twice: at the root, and under a sub-path.
 *
 * The arcade mounts each game at `/<slug>/`, so "works at the root" is not the same claim as
 * "works deployed". Serving both from one process means the e2e suite can prove the same dist
 * is correct in both places — and means the two mounts cannot race each other over a shared
 * `dist/`, which two `npm run build` web servers would.
 */
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import process from 'node:process';
import console from 'node:console';

const DIST = resolve('dist');
const SUBPATH = '/shoplifter/';
const ROOT_PORT = Number(process.env.E2E_ROOT_PORT ?? 4290);
const SUBPATH_PORT = Number(process.env.E2E_SUBPATH_PORT ?? 4291);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.wgsl': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

/**
 * @param {string} prefix Mount point, `'/'` or a directory path ending in a slash.
 * @returns {import('node:http').Server}
 */
const serve = (prefix) =>
  createServer((request, response) => {
    let pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);

    if (prefix !== '/') {
      if (pathname === prefix.slice(0, -1)) {
        // Mirror a real static host: /shoplifter must redirect to /shoplifter/, or every
        // document-relative URL resolves one directory too high.
        response.writeHead(301, { location: prefix });
        response.end();
        return;
      }
      if (!pathname.startsWith(prefix)) {
        response.writeHead(404).end('not found');
        return;
      }
      pathname = '/' + pathname.slice(prefix.length);
    }

    if (pathname.endsWith('/')) pathname += 'index.html';

    const target = join(DIST, normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
    if (!target.startsWith(DIST)) {
      response.writeHead(403).end('forbidden');
      return;
    }

    try {
      const stat = statSync(target);
      if (!stat.isFile()) throw new Error('not a file');
      response.writeHead(200, {
        'content-type': TYPES[extname(target)] ?? 'application/octet-stream',
        'content-length': stat.size,
      });
      createReadStream(target).pipe(response);
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    }
  });

serve('/').listen(ROOT_PORT, '127.0.0.1', () =>
  console.log(`root      http://127.0.0.1:${ROOT_PORT}/`),
);
serve(SUBPATH).listen(SUBPATH_PORT, '127.0.0.1', () =>
  console.log(`sub-path  http://127.0.0.1:${SUBPATH_PORT}${SUBPATH}`),
);
