### Usage

```js
const kbank = new KBank(username, password);
if (!kbank.isLogin()) kbank.login();
const accts = kbank.getAccounts();
console.logs(kbank.getBalances());
const now = new Date().getTime();
const end = new Date(now - 86400);
const start = new Date(now - 86400 * 10);
for await (const stmt of kbank.getStatement(accts[0].number, start, end))
    console.log(stmt);
kbank.logout();
```
