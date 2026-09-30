'use strict';

// Small, dependency-free lexers for source previews. Tokens are rendered as
// text nodes/spans, never HTML, so repository contents cannot inject markup.
const sourceLanguages = {
  go: {
    keywords: new Set('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var'.split(' ')),
    types: new Set('bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr any comparable'.split(' ')),
    builtins: new Set('append cap clear close complex copy delete imag len make max min new panic print println real recover'.split(' ')),
    literals: new Set('true false nil iota'.split(' ')),
    pattern: /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|`[^`]*(?:`|$)|"(?:\\[^\n]|[^"\\\n])*"?|'(?:\\[^\n]|[^'\\\n])*'?|\b(?:0[xX][\da-fA-F_]+(?:\.[\da-fA-F_]*)?(?:[pP][+-]?[\d_]+)?|0[bB][01_]+|0[oO][0-7_]+|[\d_]+(?:\.[\d_]*)?(?:[eE][+-]?[\d_]+)?)[i]?\b|\.[\d_]+(?:[eE][+-]?[\d_]+)?i?|\b[A-Za-z_][\w]*\b/g,
  },
  zig: {
    keywords: new Set('addrspace align allowzero and anyframe anytype asm async await break callconv catch comptime const continue defer else enum errdefer error export extern fn for if inline linksection noalias noinline nosuspend opaque or orelse packed pub resume return section struct suspend switch test threadlocal try union unreachable usingnamespace var volatile while'.split(' ')),
    types: new Set('anyerror anyopaque bool c_char c_int c_long c_longdouble c_longlong c_short c_uint c_ulong c_ulonglong c_ushort comptime_float comptime_int f16 f32 f64 f80 f128 isize noreturn type usize void'.split(' ')),
    builtins: new Set(),
    literals: new Set('true false null undefined'.split(' ')),
    pattern: /\/\/[^\n]*|\\\\[^\n]*|@"(?:\\[^\n]|[^"\\\n])*"?|"(?:\\[^\n]|[^"\\\n])*"?|'(?:\\[^\n]|[^'\\\n])*'?|@[A-Za-z_]\w*|\b(?:0[xX][\da-fA-F_]+(?:\.[\da-fA-F_]*)?(?:[pP][+-]?[\d_]+)?|0[bB][01_]+|0[oO][0-7_]+|[\d_]+(?:\.[\d_]*)?(?:[eE][+-]?[\d_]+)?)\b|\b[A-Za-z_]\w*\b/g,
  },
};

const quotedSourceString = /"(?:\\[\s\S]|[^"\\\n])*"?|'(?:\\[\s\S]|[^'\\\n])*'?/;
const sourceNumber = /\b(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?[\d_]+)?)\b/;
const cSourceComments = /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/;
const hashSourceComments = /#[^\n]*/;

function addSourceLanguage(extensions, { keywords = '', types = '', builtins = '', literals = 'true false null', rules = [], insensitive = false }) {
  const words = text => new Set(text.split(' ').filter(Boolean));
  const language = {
    keywords: words(keywords), types: words(types), builtins: words(builtins), literals: words(literals), insensitive,
    pattern: new RegExp([...rules, ['number', sourceNumber], ['identifier', /[$A-Za-z_][$\w]*/]].map(([kind, pattern]) => `(?<${kind}>${pattern.source})`).join('|'), insensitive ? 'gi' : 'g'),
  };
  for (const extension of extensions.split(' ')) sourceLanguages[extension] = language;
}

addSourceLanguage('js mjs cjs jsx ts mts cts tsx', {
  keywords: 'as async await break case catch class const continue debugger declare default delete do else enum export extends finally for from function get if implements import in infer instanceof interface keyof let namespace new of private protected public readonly return satisfies set static super switch this throw try type typeof var void while with yield',
  types: 'any bigint boolean never number object string symbol unknown',
  builtins: 'Array BigInt Boolean Date Error JSON Map Math Number Object Promise RegExp Set String Symbol console',
  literals: 'true false null undefined NaN Infinity',
  rules: [['comment', cSourceComments], ['string', /`(?:\\[\s\S]|[^`\\])*(?:`|$)|"(?:\\[\s\S]|[^"\\\n])*"?|'(?:\\[\s\S]|[^'\\\n])*'?/]],
});
addSourceLanguage('py pyw', {
  keywords: 'and as assert async await break case class continue def del elif else except finally for from global if import in is lambda match nonlocal not or pass raise return try while with yield',
  builtins: 'abs all any bool bytes dict enumerate float int len list map max min open print range repr set sorted str sum super tuple type zip',
  literals: 'True False None',
  rules: [['comment', hashSourceComments], ['string', /(?:[rRuUbBfF]{1,2})?(?:"""(?:\\[\s\S]|(?!""")[^\\])*(?:"""|$)|'''(?:\\[\s\S]|(?!''')[^\\])*(?:'''|$)|"(?:\\[\s\S]|[^"\\\n])*"?|'(?:\\[\s\S]|[^'\\\n])*'?)/]],
});
addSourceLanguage('rs', {
  keywords: 'as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while',
  types: 'bool char str String usize isize u8 u16 u32 u64 u128 i8 i16 i32 i64 i128 f32 f64 Option Result Vec',
  literals: 'true false None Some Ok Err',
  rules: [['comment', cSourceComments], ['string', /r(?<hashes>#{0,16})"[\s\S]*?(?:"\k<hashes>|$)|b?"(?:\\[\s\S]|[^"\\\n])*"?|b?'(?:\\[^\n]|[^'\\\n])'/], ['builtin', /\b[A-Za-z_]\w*!/]],
});
addSourceLanguage('c h cc cpp cxx hpp hxx java cs', {
  keywords: 'abstract alignas alignof as asm auto base break case catch checked class concept const constexpr consteval constinit continue co_await co_return co_yield decltype default delegate delete do else enum event explicit export extends extern final finally fixed for foreach friend goto if implements import in inline instanceof interface internal is lock namespace native new noexcept operator out override package params private protected public readonly record register requires restrict return sealed sizeof stackalloc static strictfp struct super switch synchronized template this thread_local throw throws transient try typedef typename unchecked union unsafe using virtual volatile while yield',
  types: 'bool boolean byte char decimal double dynamic float int long object sbyte short signed size_t string uint ulong unsigned ushort void wchar_t',
  literals: 'true false null nullptr NULL',
  rules: [['comment', cSourceComments], ['string', quotedSourceString], ['builtin', /#[ \t]*[A-Za-z_]+/]],
});
addSourceLanguage('rb rake gemspec', {
  keywords: 'alias and begin break case class def defined do else elsif end ensure for if in module next not or redo rescue retry return self super then undef unless until when while yield',
  builtins: 'puts print require require_relative attr_accessor attr_reader attr_writer',
  literals: 'true false nil',
  rules: [['comment', hashSourceComments], ['string', quotedSourceString]],
});
addSourceLanguage('sh bash zsh', {
  keywords: 'case do done elif else esac fi for function if in select then time until while',
  builtins: 'alias cd echo eval exec exit export local printf pwd read readonly set shift source test trap unset',
  literals: 'true false',
  rules: [['comment', hashSourceComments], ['string', quotedSourceString], ['builtin', /\$\{[^}\n]*\}|\$[A-Za-z_]\w*|\$[\d@*#?!$-]/]],
});
addSourceLanguage('sql', {
  keywords: 'add all alter and as asc begin between by case check column commit constraint create cross database default delete desc distinct drop else end exists foreign from full group having if in index inner insert into is join key left like limit not offset on or order outer primary references right rollback select set table then truncate union unique update using values view when where with',
  types: 'bigint boolean char date decimal double float int integer numeric text timestamp varchar',
  literals: 'true false null', insensitive: true,
  rules: [['comment', /--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/], ['string', /'(?:''|[^'])*(?:'|$)|"(?:""|[^"])*(?:"|$)/]],
});
addSourceLanguage('json jsonc', {
  rules: [['comment', cSourceComments], ['property', /"(?:\\[^\n]|[^"\\\n])*"(?=\s*:)/], ['string', /"(?:\\[^\n]|[^"\\\n])*"?/]],
});
addSourceLanguage('yaml yml', {
  literals: 'true false null yes no on off', insensitive: true,
  rules: [['comment', hashSourceComments], ['string', quotedSourceString], ['property', /[\w.-]+(?=\s*:\s|\s*:$)/m]],
});
addSourceLanguage('css scss less', {
  rules: [['comment', cSourceComments], ['string', quotedSourceString], ['literal', /#[\da-fA-F]{3,8}\b/], ['property', /[\w-]+(?=\s*:)/], ['keyword', /@[\w-]+/]],
});
addSourceLanguage('html htm xml svg', {
  literals: '',
  rules: [['comment', /<!--[\s\S]*?(?:-->|$)/], ['string', quotedSourceString], ['keyword', /<!DOCTYPE[^>]*>|<\/?[\w:.-]+/i], ['property', /[\w:.-]+(?=\s*=)/], ['literal', /&(?:#\d+|#x[\da-fA-F]+|\w+);/]],
});

function sourceTokens(content, path) {
  const filename = path.split('/').at(-1).toLowerCase();
  const extension = filename.split('.').at(-1);
  let language = Object.hasOwn(sourceLanguages, extension) ? sourceLanguages[extension] : null;
  if (!language && /^(?:#!.*\b(?:bash|sh|zsh))/.test(content)) language = sourceLanguages.sh;
  if (!language && /^(?:#!.*\bpython[\d.]*)/.test(content)) language = sourceLanguages.py;
  if (!language) return [{ text: content, kind: '' }];
  const tokens = [];
  let offset = 0;
  for (const match of content.matchAll(language.pattern)) {
    if (match.index > offset) tokens.push({ text: content.slice(offset, match.index), kind: '' });
    const text = match[0];
    const word = language.insensitive ? text.toLowerCase() : text;
    let kind = match.groups ? Object.keys(match.groups).find(key => key !== 'identifier' && key !== 'hashes' && match.groups[key] !== undefined) || '' : '';
    if (!kind) {
      if (!match.groups && (text.startsWith('//') || (extension === 'go' && text.startsWith('/*')))) kind = 'comment';
      else if (/^(?:["'`]|\\\\|@")/.test(text)) kind = 'string';
      else if (/^(?:\d|\.\d)/.test(text)) kind = 'number';
      else if (language.keywords.has(word)) kind = 'keyword';
      else if (language.literals.has(word)) kind = 'literal';
      else if (language.types.has(word) || (extension === 'zig' && /^[iu]\d+$/.test(text))) kind = 'type';
      else if (language.builtins.has(word) || text.startsWith('@')) kind = 'builtin';
    }
    tokens.push({ text, kind });
    offset = match.index + text.length;
  }
  if (offset < content.length) tokens.push({ text: content.slice(offset), kind: '' });
  return tokens;
}

function sourceTokenLines(content, path) {
  const lines = [[]];
  for (const token of sourceTokens(content, path)) {
    token.text.split('\n').forEach((text, index) => {
      if (index) lines.push([]);
      if (text) lines.at(-1).push({ text, kind: token.kind });
    });
  }
  if (content.endsWith('\n')) lines.pop();
  return lines;
}
