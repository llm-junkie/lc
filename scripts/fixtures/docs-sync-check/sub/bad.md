# Bad fixture document

Every reference below is broken on purpose. The checker must flag exactly these.

- broken file link: [missing](./missing.md)
- wrong-case link: [case](../GOOD.md)
- broken cross-file anchor: [anchor](./target.md#no-such-heading)
- broken same-file anchor: [here](#absent-anchor)
- broken directory link: [dir](./nodir/)
- broken source path: `fixture-src/absent.txt`
- missing brace-list member: `fixture-src/{hello,absent}.txt`
- broken reference target: [missing by reference][missing-file]
- broken shortcut reference target: [missing shortcut]
- missing reference definition: [missing definition][not-defined]
- broken single-quoted HTML link: <a href='./missing-html.md'>missing HTML target</a>

Leakage: the checker must flag this reference because record
a99__202601010101 exists in the fixture logs directory.

A16 subcode leakage: a16c__202601020202 also exists in that directory.

```text
[this link is inside a fence and must be ignored](./also-missing.md)
# this is not a heading either
```

[missing-file]: ./missing-reference.md
[missing shortcut]: ./missing-shortcut.md
