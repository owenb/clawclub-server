export function buildVouchReceivedMessage(input: {
  voucherPublicName: string;
  clubName: string;
  clubId: string;
  vouchedMemberId: string;
  reason: string;
}): string {
  return `${input.voucherPublicName} vouched for you in ${input.clubName}. `
    + `You can call vouches.list(clubId: '${input.clubId}') to see all the vouches `
    + `you have received in this club, or members.get(clubId: '${input.clubId}', `
    + `memberId: '${input.vouchedMemberId}') to see your full member profile there. `
    + `Reason: ${input.reason}`;
}
