// PLATFORM BUILT-IN MODULE VOCABULARY.
//
// A specifier naming a platform built-in has NO in-estate node by design and never will:
// `node:fs` is the runtime, not a scanned file and not a declared dependency. Two tools need
// that answer for the SAME specifier — `merge.mjs` classifies why a module ended up isolated,
// `analyze-connectivity.mjs` classifies why a record went unresolved — and two private copies
// of the list would let them disagree about the same string.
//
// WHY THIS IS ITS OWN MODULE AND NOT PART OF lib.mjs. `estateMapVcsIndependent.test.mjs`
// asserts that `lib.mjs` and `extract.mjs` contain no reference to the process-spawning
// built-in, because spawning a VCS binary is exactly the dependency the scanner refuses to
// take. A built-in NAME LIST necessarily contains that name as data, so putting the list in
// lib.mjs would either trip that guard or force it to be weakened — and the guard is worth
// more than the co-location. This module is data only: no imports, no I/O, no execution, and
// nothing here is ever passed to a loader.

export const NODE_BUILTIN_MODULES = Object.freeze(new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants',
  'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'http', 'http2',
  'https', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode',
  'querystring', 'readline', 'repl', 'sea', 'sqlite', 'stream', 'string_decoder', 'sys', 'test',
  'timers', 'tls', 'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads',
  'zlib',
]));

/** True for `node:x`, `node:x/sub`, or a bare specifier whose root is a Node built-in. */
export const isNodeBuiltinSpecifier = specifier => {
  const value = String(specifier || '');
  if (value.startsWith('node:')) return true;
  return NODE_BUILTIN_MODULES.has(value.split('/')[0]);
};

// Python 3.12 top-level stdlib module names. A stdlib import is external by definition, even
// when a vendored copy of the same name happens to sit inside the scanned tree (a
// `.venv/lib/**/site-packages/json/` directory must not make `import json` look like a missing
// in-estate edge). Static list, so the classification stays deterministic and offline.
export const PYTHON_STDLIB_MODULES = Object.freeze(new Set(['__future__', '_thread', 'abc', 'aifc', 'argparse', 'array', 'ast', 'asyncio', 'atexit', 'base64', 'bdb', 'binascii', 'bisect', 'builtins', 'bz2', 'calendar', 'cgi', 'cgitb', 'chunk', 'cmath', 'cmd', 'code', 'codecs', 'codeop', 'collections', 'colorsys', 'compileall', 'concurrent', 'configparser', 'contextlib', 'contextvars', 'copy', 'copyreg', 'crypt', 'csv', 'ctypes', 'curses', 'dataclasses', 'datetime', 'dbm', 'decimal', 'difflib', 'dis', 'doctest', 'email', 'encodings', 'ensurepip', 'enum', 'errno', 'faulthandler', 'fcntl', 'filecmp', 'fileinput', 'fnmatch', 'fractions', 'ftplib', 'functools', 'gc', 'getopt', 'getpass', 'gettext', 'glob', 'graphlib', 'grp', 'gzip', 'hashlib', 'heapq', 'hmac', 'html', 'http', 'idlelib', 'imaplib', 'imghdr', 'importlib', 'inspect', 'io', 'ipaddress', 'itertools', 'json', 'keyword', 'linecache', 'locale', 'logging', 'lzma', 'mailbox', 'mailcap', 'marshal', 'math', 'mimetypes', 'mmap', 'modulefinder', 'msvcrt', 'multiprocessing', 'netrc', 'nis', 'nntplib', 'ntpath', 'numbers', 'operator', 'optparse', 'os', 'ossaudiodev', 'pathlib', 'pdb', 'pickle', 'pickletools', 'pipes', 'pkgutil', 'platform', 'plistlib', 'poplib', 'posix', 'posixpath', 'pprint', 'profile', 'pstats', 'pty', 'pwd', 'py_compile', 'pyclbr', 'pydoc', 'queue', 'quopri', 'random', 're', 'readline', 'reprlib', 'resource', 'rlcompleter', 'runpy', 'sched', 'secrets', 'select', 'selectors', 'shelve', 'shlex', 'shutil', 'signal', 'site', 'smtplib', 'sndhdr', 'socket', 'socketserver', 'spwd', 'sqlite3', 'ssl', 'stat', 'statistics', 'string', 'stringprep', 'struct', 'subprocess', 'sunau', 'symtable', 'sys', 'sysconfig', 'syslog', 'tabnanny', 'tarfile', 'telnetlib', 'tempfile', 'termios', 'textwrap', 'threading', 'time', 'timeit', 'tkinter', 'token', 'tokenize', 'tomllib', 'trace', 'traceback', 'tracemalloc', 'tty', 'turtle', 'types', 'typing', 'unicodedata', 'unittest', 'urllib', 'uu', 'uuid', 'venv', 'warnings', 'wave', 'weakref', 'webbrowser', 'winreg', 'winsound', 'wsgiref', 'xdrlib', 'xml', 'xmlrpc', 'zipapp', 'zipfile', 'zipimport', 'zlib', 'zoneinfo']));
