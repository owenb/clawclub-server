import { buildBearerToken } from './token.ts';

const memberId = process.argv[2];
const label = process.argv[3] ?? 'default';

if (!memberId) {
  console.error('usage: node --experimental-strip-types src/token-cli.ts <member_id> [label]');
  process.exit(1);
}

const token = buildBearerToken();

console.log(
  JSON.stringify(
    {
      memberId,
      label,
      bearerToken: token.bearerToken,
      insertSql:
        'insert into app.member_bearer_tokens (id, member_id, label, token_hash) values ' +
        `('${token.tokenId}', '${memberId}', '${label.replace(/'/g, "''")}', '${token.tokenHash}');`,
    },
    null,
    2,
  ),
);
