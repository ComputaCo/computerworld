# names

Placeholders that hold ComputaCo's names on the package registries until each has its real code. Each is version
0.0.1, says what it will be, and has no functions.

| name | PyPI | npm | crates.io |
|---|---|---|---|
| `computaco` | placeholder | placeholder | placeholder |
| `computatrum` | placeholder | placeholder | placeholder |
| `computaco-core` | placeholder | placeholder | placeholder |
| `computerworld` | the owner's engine wheels (JacobFV/computerworld) | the owner's engine for Wasm (JacobFV/computerworld) | placeholder: the engine's crate takes it |
| `computerworld-cloud` | the Python client, `python/` | the JS client, this repository's root | — |

The npm scope `@computaco` is the npm organisation `computaco`.

How each was made (2026-11-25): PyPI by `publish.yml` (`what: names`) through a pending trusted publisher; npm by
`npm publish names/<name> --access public`, logged in; crates.io by `cargo publish` with CommandAGI's crates.io token
(`crates/hello-commandagi` in computaco-service's registry). A real version replaces a placeholder from the
repository that holds its code, with that repository as the package's trusted publisher.
