const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Valid categories ──────────────────────────────────────────
const CATEGORIES = ['INTERESTED', 'WANTS_CALL', 'NOT_INTERESTED', 'OPT_OUT', 'UNCLEAR'];

// ── Categorize an inbound SMS reply ──────────────────────────
async function categorizeReply(replyText) {
  try {
    const response = await client.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 50,
      messages: [{
        role: 'user',
        content: `You are categorizing SMS replies to real estate land-buying outreach.

Classify this reply into EXACTLY ONE of these categories:
- INTERESTED: open to hearing an offer, wants more info, sounds willing to sell
- WANTS_CALL: explicitly asks to be called or says to call them
- NOT_INTERESTED: clear rejection, not selling, not interested
- OPT_OUT: wants to stop receiving messages (stop, remove me, don't text, unsubscribe, etc.)
- UNCLEAR: ambiguous, question, off-topic, or can't determine intent

Reply text: "${replyText}"

Respond with ONLY the category name, nothing else.`
      }]
    });

    const raw = response.content[0]?.text?.trim().toUpperCase();
    const category = CATEGORIES.find(c => raw === c);

    if (!category) {
      console.warn(`Claude returned unexpected category: "${raw}" — defaulting to UNCLEAR`);
      return 'UNCLEAR';
    }

    return category;
  } catch (err) {
    console.error('Claude categorization failed:', err.message);
    return 'UNCLEAR'; // safe default — you'll see it flagged for manual review
  }
}

module.exports = { categorizeReply };