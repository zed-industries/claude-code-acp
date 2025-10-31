## How to publish a new release

1. Create a new branch prep-vX.X.X

```sh
git checkout -b prep-vX.X.X
```

2. Bump the version in package.json

```sh
npm version vX.X.X
```

3. Add a new entry in CHANGELOG.md
4. Create a PR for `prev-vX.X.X` & merge it
5. Create tag and push it

```sh
git tag vX.X.X
git push origin vX.X.X
```

6. Paste CHANGELOG into release notes and publish the version on GitHub
