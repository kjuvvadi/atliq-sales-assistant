// GET /api/status - tells the page whether the AI key is set, without revealing it.
export default function handler(req, res) {
  res.status(200).json({
    aiConnected: Boolean(process.env.GROQ_API_KEY),
    model: process.env.ANALYSIS_MODEL || "openai/gpt-oss-120b",
  });
}
