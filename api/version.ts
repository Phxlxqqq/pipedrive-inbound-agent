export default function handler(_: any, res: any) {
  res.status(200).json({ sha: process.env.VERCEL_GIT_COMMIT_SHA || 'local' });
}
 