// errorNotifier.js
const nodemailer = require('nodemailer');

// Only attempt to create the transporter if essential environment variables are set
const transporter = (process.env.EMAIL_HOST && process.env.EMAIL_USER && process.env.EMAIL_PASS) ?
  nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: parseInt(process.env.EMAIL_PORT || '587', 10),
    secure: parseInt(process.env.EMAIL_PORT || '587', 10) === 465,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
    connectionTimeout: 10000, // Increased timeout slightly
    socketTimeout: 10000, // Increased timeout slightly
    logger: process.env.NODE_ENV !== 'production', // Log connection activity in dev
    debug: process.env.NODE_ENV !== 'production',   // Log detailed debug info in dev
  }) : null; // Set to null if configuration is missing

if (transporter) {
    transporter.verify(function (error, success) {
      if (error) {
        // Log this as an error, but not necessarily fatal to the whole app startup
        console.error('❌ Email transporter verification failed:', error.message);
        if (process.env.NODE_ENV !== 'production') {
             console.error('Verification error details:', error); // Log full error in dev
        }
      } else {
        console.log('✅ Email transporter is configured and verified.');
      }
    });
} else {
    console.warn('⚠️ Email notification is disabled. EMAIL_HOST, EMAIL_USER, or EMAIL_PASS environment variables are not fully set.');
}


async function notifyAdminOfError(subject, error, context = '') {
  // Check if transporter was successfully created (i.e., env vars were set)
  if (!transporter) {
    // Configuration is missing, skip sending and logging a message
    // console.warn(`Email notification for "${subject}" suppressed due to missing configuration.`);
    // console.warn('Suppressed email notification details:', { subject, error, context });
    return;
  }

  // Also check for the admin recipient email
   if (!process.env.ADMIN_EMAIL_RECIPIENT) {
       console.warn(`Email notification for "${subject}" suppressed. ADMIN_EMAIL_RECIPIENT is not set.`);
        return;
   }


  let errorDetails = '';
  if (error instanceof Error) {
    errorDetails = `
      <p><strong>Message:</strong> ${error.message}</p>
      <pre style="background-color: #f0f0f0; padding: 10px; border: 1px solid #ccc; border-radius: 5px; white-space: pre-wrap; word-wrap: break-word;">${error.stack || 'No stack trace available'}</pre>
    `;
  } else {
    // Handle cases where the 'error' argument isn't a standard Error object
    try {
        errorDetails = `
          <p><strong>Details:</strong></p>
          <pre style="background-color: #f0f0f0; padding: 10px; border: 1px solid #ccc; border-radius: 5px; white-space: pre-wrap; word-wrap: break-word;">${JSON.stringify(error, null, 2)}</pre>
        `;
    } catch (e) {
         errorDetails = `<p>Could not stringify error details.</p><pre>${error}</pre>`;
    }
  }


  try {
    const mailOptions = {
      from: `"API Server Alert" <${process.env.EMAIL_USER}>`, // Use the configured user as 'from'
      to: process.env.ADMIN_EMAIL_RECIPIENT,
      subject: `🚨 ALERT: ${subject}`,
      html: `
        <h1>Application Event Notification</h1>
        <p><strong>Environment:</strong> ${process.env.NODE_ENV || 'development'}</p>
        <p><strong>Timestamp:</strong> ${new Date().toISOString()}</p>
        <p><strong>Subject:</strong> ${subject}</p>
        ${context ? `<p><strong>Context:</strong></p><pre style="background-color: #f9f9f9; padding: 10px; border: 1px dashed #ccc; border-radius: 5px; white-space: pre-wrap; word-wrap: break-word;">${context}</pre>` : ''}
        <hr>
        <h2>Details:</h2>
        ${errorDetails}
      `,
    };

    const info = await transporter.sendMail(mailOptions);
    console.log(`✅ Admin notification sent for: "${subject}". Message ID: ${info.messageId}`);
  } catch (emailError) {
    // Change FATAL to ERROR or WARN here, as failing to send the email
    // should not crash the whole application if email is optional.
    console.error('❌ Could not send notification email.', emailError.message);
     if (process.env.NODE_ENV !== 'production') {
         console.error('Email send error details:', emailError); // Log full error in dev
     }
    // Do NOT re-throw the error here, as the purpose is to report *another* error
    // without causing a new failure loop related to email.
  }
}

module.exports = { notifyAdminOfError };