const express = require('express');
const router  = express.Router();
const { handleCallback } = require('./email');

// Microsoft redirects here after user approves
router.get('/auth/microsoft/callback', async (req, res) => {
  const { code, state: clientId, error } = req.query;

  if (error) {
    return res.send(`<html><body><script>
      window.opener?.postMessage({ type: 'MS_AUTH_ERROR', error: '${error}' }, '*');
      window.close();
    </script></body></html>`);
  }

  try {
    const email = await handleCallback(code, clientId, 'microsoft');
    res.send(`<html><body><script>
      window.opener?.postMessage({ type: 'MS_AUTH_SUCCESS', email: '${email || ''}' }, '*');
      window.close();
    </script></body></html>`);
  } catch (e) {
    console.error('Microsoft OAuth callback error:', e.message);
    res.send(`<html><body><script>
      window.opener?.postMessage({ type: 'MS_AUTH_ERROR', error: '${e.message}' }, '*');
      window.close();
    </script></body></html>`);
  }
});

// Google redirects here after user approves
router.get('/auth/google/callback', async (req, res) => {
  const { code, state: clientId, error } = req.query;

  if (error) {
    return res.send(`<html><body><script>
      window.opener?.postMessage({ type: 'GOOGLE_AUTH_ERROR', error: '${error}' }, '*');
      window.close();
    </script></body></html>`);
  }

  try {
    const email = await handleCallback(code, clientId, 'google');
    res.send(`<html><body><script>
      window.opener?.postMessage({ type: 'GOOGLE_AUTH_SUCCESS', email: '${email || ''}' }, '*');
      window.close();
    </script></body></html>`);
  } catch (e) {
    console.error('Google OAuth callback error:', e.message);
    res.send(`<html><body><script>
      window.opener?.postMessage({ type: 'GOOGLE_AUTH_ERROR', error: '${e.message}' }, '*');
      window.close();
    </script></body></html>`);
  }
});

module.exports = router;
