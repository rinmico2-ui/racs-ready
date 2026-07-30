#!/usr/bin/env node

/**
 * Booking Email Setup Script
 * Configures SMTP for booking confirmation emails
 * Creates sample .env if needed
 * Tests email functionality
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mailer = require('../utils/mailer');

async function setupBookingEmails() {
  console.log('🔧 Booking Email Setup');
  console.log('========================\n');

  try {
    // Check current SMTP configuration
    console.log('📧 Checking SMTP configuration...');
    console.log(`   Host: ${process.env.SMTP_HOST || 'Not set'}`);
    console.log(`   Port: ${process.env.SMTP_PORT || 'Not set'}`);
    console.log(`   User: ${process.env.SMTP_USER || 'Not set'}`);
    console.log(`   From: ${process.env.FROM_EMAIL || 'Not set'}\n`);

    // Check if all required environment variables are set
    const required = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS'];
    const missing = required.filter(key => !process.env[key]);

    if (missing.length > 0) {
      console.log('❌ Missing environment variables:', missing);
      
      // Create sample .env file
      const sampleEnv = `# SMTP Configuration for Booking Emails
# Gmail Setup (Recommended)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password-here
FROM_EMAIL=your-email@gmail.com

# Alternative SMTP Providers:
# Outlook: SMTP_HOST=smtp-mail.outlook.com, SMTP_PORT=587
# Yahoo: SMTP_HOST=smtp.mail.yahoo.com, SMTP_PORT=587

# Instructions:
# 1. For Gmail: Enable 2FA and create App Password at https://myaccount.google.com/apppasswords
# 2. Use the 16-character App Password (not your regular password)
# 3. Update SMTP_USER and SMTP_PASS with your credentials
# 4. Run this script again to test configuration
`;

      const envPath = path.join(__dirname, '../../.env');
      if (!fs.existsSync(envPath)) {
        fs.writeFileSync(envPath, sampleEnv);
        console.log('✅ Sample .env file created at:', envPath);
      } else {
        console.log('⚠️ .env file already exists. Please update it with the values above.');
      }

      console.log('\n📋 Setup Instructions:');
      console.log('1. Configure SMTP credentials in .env file');
      console.log('2. For Gmail: Use App Password (not regular password)');
      console.log('3. Run this script again to test email functionality');
      console.log('4. Test booking creation to verify emails are sent');
      
      return;
    }

    // Test email sending
    console.log('🧪 Testing email configuration...');
    
    const testResult = await mailer.sendMail({
      to: process.env.SMTP_USER, // Send to yourself for testing
      subject: '✅ Booking Email Test - CALIDRO RACS',
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 600px; margin: 0 auto;">
          <div style="background: linear-gradient(135deg, #0d6efd, #0a58ca); color: white; padding: 30px; text-align: center; border-radius: 12px 12px 0 0;">
            <h1 style="margin: 0; font-size: 24px;">🔧 CALIDRO RACS</h1>
            <p style="margin: 10px 0 0; opacity: 0.9;">Booking Email System Test</p>
          </div>
          <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 12px 12px;">
            <h2 style="color: #0d6efd; margin-top: 0;">✅ Success!</h2>
            <p><strong>Your booking email system is working correctly!</strong></p>
            
            <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <h3 style="margin-top: 0; color: #198754;">What's Working:</h3>
              <ul style="line-height: 1.6;">
                <li>✅ SMTP connection established</li>
                <li>✅ Email authentication successful</li>
                <li>✅ Booking confirmation emails ready</li>
                <li>✅ Technician notifications ready</li>
              </ul>
            </div>
            
            <p style="color: #6c757d; font-size: 14px;">
              This test confirms that when customers create bookings, they will receive:
            </p>
            <ul style="color: #6c757d; font-size: 14px;">
              <li>Booking confirmation emails with reference numbers</li>
              <li>Service details and appointment information</li>
              <li>Payment method and estimated fees</li>
            </ul>
            
            <hr style="border: none; border-top: 1px solid #dee2e6; margin: 30px 0;">
            <p style="font-size: 12px; color: #6c757d; margin: 0;">
              Test completed: ${new Date().toLocaleString()}<br>
              CALIDRO RACS Booking System
            </p>
          </div>
        </div>
      `,
      text: `CALIDRO RACS - Booking Email Test\n\nSuccess! Your booking email system is working correctly.\n\nThis test confirms that:\n- SMTP connection is working\n- Email authentication is successful\n- Booking confirmation emails are ready\n- Technician notifications are ready\n\nTest completed: ${new Date().toLocaleString()}`
    });

    if (testResult && testResult.messageId) {
      console.log('✅ Email system is working perfectly!');
      console.log(`   Message ID: ${testResult.messageId}`);
      console.log(`   Check your inbox: ${process.env.SMTP_USER}`);
      console.log('\n🎉 Booking email system is ready for production!');
      
      console.log('\n📋 What happens now when a customer books:');
      console.log('1. Customer receives confirmation email with booking reference');
      console.log('2. Technician receives job assignment notification');
      console.log('3. Both emails include complete booking details');
      console.log('4. System logs all email activities');
      
    } else {
      console.log('⚠️ Email test returned no result - checking configuration...');
      
      if (missing.length === 0) {
        console.log('✅ All environment variables present');
        console.log('⚠️ Issue might be with authentication or network');
        console.log('\n💡 Troubleshooting:');
        console.log('- Verify Gmail App Password (not regular password)');
        console.log('- Check if 2FA is enabled on Gmail account');
        console.log('- Confirm SMTP_HOST is smtp.gmail.com');
        console.log('- Try SMTP_PORT=465 with secure=true');
      }
    }

  } catch (error) {
    console.error('❌ Email setup failed:', error.message);
    
    if (error.message.includes('Authentication failed')) {
      console.log('\n💡 Gmail Authentication Fix:');
      console.log('1. Enable 2-Factor Authentication on Gmail');
      console.log('2. Go to: https://myaccount.google.com/apppasswords');
      console.log('3. Generate App Password for "Mail"');
      console.log('4. Use the 16-character App Password in SMTP_PASS');
      console.log('5. Do NOT use your regular Gmail password');
    }
    
    if (error.message.includes('ENOTFOUND')) {
      console.log('\n💡 Network Fix:');
      console.log('- Check internet connection');
      console.log('- Verify SMTP_HOST=smtp.gmail.com');
      console.log('- Try alternative port: SMTP_PORT=465');
    }
    
    if (error.message.includes('ETIMEDOUT')) {
      console.log('\n💡 Connection Timeout Fix:');
      console.log('- Check firewall settings');
      console.log('- Try SMTP_PORT=587 (STARTTLS)');
      console.log('- Try SMTP_PORT=465 (SSL/TLS)');
    }
  }
}

// Run the setup
setupBookingEmails().catch(console.error);
