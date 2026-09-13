# Good fixture document

Everything here resolves. The checker must not flag any item.

- file link: [target](./sub/target.md)
- reached through this file: [bad](./sub/bad.md)
- reached through this file: [bad-extra](./sub/bad-extra.md)
- same-file anchor: [notes](#notes)
- cross-file anchor: [one](./sub/target.md#section-one)
- reference-style anchor: [one by reference][section-one]
- collapsed reference-style anchor: [one collapsed][]
- shortcut reference-style anchor: [one shortcut]
- single-quoted HTML link: <a href='./sub/target.md#section-one'>one in HTML</a>
- duplicate heading suffix: [one again](./sub/target.md#section-one-1)
- punctuation heading: [punct](./sub/target.md#with-code-and-punctuation)
- source path: `fixture-src/hello.txt`
- brace list: `fixture-src/{hello,world}.txt`
- glob: `fixture-src/*.txt`
- directory link: [logs](./logs/)
- format example with no such record: zz__202601010101 — must not be flagged
- trailing-punctuation heading keeps its trailing hyphen: [stars](#stars-)

## Notes

Nothing to see.

## Stars (*****)

The GitHub-style slug keeps the trailing hyphen. The anchor above resolves.

[section-one]: ./sub/target.md#section-one
[one collapsed]: ./sub/target.md#section-one
[one shortcut]: ./sub/target.md#section-one
