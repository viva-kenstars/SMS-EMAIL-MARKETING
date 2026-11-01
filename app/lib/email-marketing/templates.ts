export type EmailTemplate = {
  id: string;
  name: string;
  category: string;
  description: string;
  color: string;
  subject: string;
  preheader: string;
  html: string;
  text: string;
};

const paragraph = (text: string) => `<p style="margin:0 0 20px;color:#475569;font-size:16px;line-height:1.8;">${text}</p>`;
const heading = (text: string) => `<h1 style="margin:0 0 20px;color:#102134;font-size:32px;line-height:1.25;letter-spacing:-.8px;">${text}</h1>`;
const button = (text: string, color = "#0969da") => `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:26px 0;"><tr><td style="border-radius:6px;background-color:${color};"><a href="https://trezad.com" style="display:inline-block;padding:14px 24px;color:#ffffff;text-decoration:none;font-weight:bold;font-size:15px;">${text} &rarr;</a></td></tr></table>`;
const frame = (body: string, accent = "#0969da", label = "A NOTE FROM TREZAD") => `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Trezad</title></head>
<body style="margin:0;padding:0;background-color:#f3f6fa;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color:#f3f6fa;font-family:Arial,Helvetica,sans-serif;"><tr><td align="center" style="padding:32px 12px;">
<table role="presentation" cellpadding="0" cellspacing="0" width="600" style="width:100%;max-width:600px;background-color:#ffffff;border:1px solid #e3e9f0;border-radius:10px;">
<tr><td style="padding:30px 32px 24px;border-bottom:1px solid #edf1f5;"><a href="https://trezad.com" style="color:${accent};font-size:24px;letter-spacing:-1px;font-weight:bold;text-decoration:none;">trezad<span style="color:#102134;">.</span></a><p style="margin:9px 0 0;color:#788598;font-size:10px;font-weight:bold;letter-spacing:1.8px;">${label}</p></td></tr>
<tr><td style="padding:32px;">${body}</td></tr>
<tr><td style="padding:24px 32px;border-top:1px solid #edf1f5;color:#788598;font-size:12px;line-height:1.7;"><p style="margin:0;">Sent with care by the Trezad team.</p><p style="margin:7px 0 0;"><a href="https://trezad.com" style="color:#64748b;">Visit our website</a> &nbsp;&middot;&nbsp; You can reply to this email to speak with us.</p></td></tr>
</table></td></tr></table></body></html>`;

export const EMAIL_TEMPLATES: EmailTemplate[] = [
  {
    id: "welcome", name: "A warm welcome", category: "Welcome", color: "#0969da",
    description: "Introduce your brand and give new contacts a clear next step.",
    subject: "Welcome to Trezad, {{first_name}}", preheader: "A little introduction, and what you can look forward to.",
    html: frame(`<p style="margin:0 0 16px;color:#0969da;font-size:13px;font-weight:bold;">WELCOME ABOARD</p>${heading("Good things start here.")}${paragraph("Hi {{first_name}},")}${paragraph("We’re glad you’re here. We’re building a place where discovering something useful, finding the right seller and making your next purchase feels simple.")}${paragraph("We’ll share thoughtful updates, useful ideas and products we think you’ll enjoy. You can always tell us what you’d like to see more of.")}${button("Take a look around")}${paragraph("Here’s to what comes next,<br><strong style=\"color:#102134;\">The Trezad team</strong>")}`),
    text: "Hi {{first_name}},\n\nWelcome to Trezad. We’re glad you’re here. We’ll share thoughtful updates, useful ideas and products we think you’ll enjoy.\n\nTake a look around: https://trezad.com\n\nThe Trezad team",
  },
  {
    id: "spotlight", name: "Product spotlight", category: "Products", color: "#0f766e",
    description: "Make one product the focus, with space for its best features.",
    subject: "A closer look at our latest find", preheader: "Thoughtful details. Everyday usefulness.",
    html: frame(`<div style="padding:34px 24px;margin:0 0 28px;background-color:#eaf6f2;border-radius:8px;text-align:center;"><p style="margin:0 0 12px;color:#0f766e;font-size:12px;letter-spacing:2px;font-weight:bold;">THE PRODUCT EDIT</p><h1 style="margin:0;color:#123a35;font-size:34px;line-height:1.2;">Your next<br>everyday favourite.</h1><p style="margin:16px 0 0;color:#42746c;">Add your product photograph using the image tool.</p></div>${heading("Meet [product name].")}${paragraph("Hi {{first_name}}, here’s something we thought you’d want to see. Describe what makes this product useful, who it’s for and why you chose it.")}<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:16px 0;border-top:1px solid #e3eee9;color:#37564c;">01 &nbsp; <strong>Thoughtful design</strong><br><span style="font-size:14px;">Describe a real product benefit.</span></td></tr><tr><td style="padding:16px 0;border-top:1px solid #e3eee9;color:#37564c;">02 &nbsp; <strong>Made for your day</strong><br><span style="font-size:14px;">Explain how it makes a difference.</span></td></tr></table>${button("Explore the product", "#0f766e")}`, "#0f766e", "THE PRODUCT EDIT"),
    text: "Hi {{first_name}},\n\nMeet [product name]. Describe the product and its real benefits here.\n\nExplore the product: https://trezad.com\n\nThe Trezad team",
  },
  {
    id: "offer", name: "A special offer", category: "Promotion", color: "#9a3412",
    description: "A clean offer announcement with room for conditions and dates.",
    subject: "Something special for you, {{first_name}}", preheader: "Your offer details, all in one place.",
    html: frame(`<p style="margin:0 0 16px;color:#9a3412;font-size:12px;letter-spacing:1.5px;font-weight:bold;">A LITTLE SOMETHING FOR YOU</p>${heading("A good reason<br>to take another look.")}${paragraph("Hi {{first_name}}, we’ve put together an offer we think you’ll love. Add the exact offer and the products it applies to below.")}<div style="padding:24px;background-color:#fff7ed;border:1px solid #fed7aa;border-radius:8px;text-align:center;"><p style="margin:0 0 10px;color:#9a3412;font-size:12px;font-weight:bold;letter-spacing:1px;">YOUR OFFER</p><h2 style="margin:0;color:#7c2d12;font-size:28px;">[Add your offer]</h2><p style="margin:14px 0 0;color:#9a3412;font-size:14px;">[Offer dates and any qualifying conditions]</p></div>${button("View the offer", "#9a3412")}<p style="margin:0;color:#788598;font-size:12px;line-height:1.8;">Add the offer’s full terms here. Replace all bracketed text and check the destination link before sending.</p>`, "#9a3412", "SOMETHING SPECIAL"),
    text: "Hi {{first_name}},\n\n[Add your offer]\n[Offer dates and qualifying conditions]\n\nView the offer: https://trezad.com\n\n[Full terms]\n\nThe Trezad team",
  },
  {
    id: "newsletter", name: "The monthly note", category: "Newsletter", color: "#3730a3",
    description: "Share three updates in an easy-to-scan newsletter.",
    subject: "Your latest Trezad update", preheader: "A few things worth sharing this month.",
    html: frame(`${heading("A few things<br>worth sharing.")}${paragraph("Hi {{first_name}}, here’s your latest update from us. Set the scene with a short, friendly introduction.")}<div style="padding:24px 0;border-top:1px solid #e7e5f4;"><p style="margin:0 0 9px;color:#6366f1;font-size:12px;font-weight:bold;">01 / WHAT’S NEW</p><h2 style="margin:0 0 12px;color:#1e1b4b;font-size:22px;">Your first update goes here</h2>${paragraph("Share the announcement and why it matters. Keep each section useful and give readers a clear way to learn more.")}<a href="https://trezad.com" style="color:#3730a3;font-weight:bold;font-size:14px;">Read the update &rarr;</a></div><div style="padding:24px 0;border-top:1px solid #e7e5f4;"><p style="margin:0 0 9px;color:#6366f1;font-size:12px;font-weight:bold;">02 / SOMETHING USEFUL</p><h2 style="margin:0 0 12px;color:#1e1b4b;font-size:22px;">One idea to take with you</h2>${paragraph("A practical tip, a useful resource or a story from the community. Make this section something your readers will appreciate.")}</div><div style="padding:24px;background-color:#f3f1ff;border-radius:8px;"><p style="margin:0 0 9px;color:#6366f1;font-size:12px;font-weight:bold;">03 / OVER TO YOU</p><h2 style="margin:0 0 12px;color:#1e1b4b;font-size:22px;">What would you like to see next?</h2><p style="margin:0;color:#625f81;font-size:15px;line-height:1.8;">Reply to this email. We’d love to hear your ideas.</p></div>`, "#3730a3", "THE MONTHLY NOTE"),
    text: "Hi {{first_name}},\n\nHere’s your latest Trezad update.\n\n01 / WHAT’S NEW\n[Your first update]\n\n02 / SOMETHING USEFUL\n[Your tip or resource]\n\n03 / OVER TO YOU\nWhat would you like to see next? Reply and let us know.\n\nhttps://trezad.com",
  },
  {
    id: "event", name: "You’re invited", category: "Event", color: "#1e3a5f",
    description: "An event invitation with clear date, location and RSVP details.",
    subject: "You’re invited: [event name]", preheader: "Save your place. We’d love to see you there.",
    html: frame(`<p style="margin:0 0 18px;color:#52779c;font-size:12px;font-weight:bold;letter-spacing:2px;">YOU’RE INVITED</p>${heading("Let’s make<br>something happen.")}${paragraph("Hi {{first_name}}, join us for [event name]. Tell your reader what the event is about and what they can expect.")}<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:26px 0;background-color:#eef3f8;border-radius:8px;"><tr><td style="padding:22px 24px 10px;color:#1e3a5f;font-size:12px;font-weight:bold;">WHEN</td><td style="padding:22px 24px 10px;color:#334155;font-size:15px;">[Date] &middot; [Time and time zone]</td></tr><tr><td style="padding:10px 24px 22px;color:#1e3a5f;font-size:12px;font-weight:bold;">WHERE</td><td style="padding:10px 24px 22px;color:#334155;font-size:15px;">[Venue or online meeting]</td></tr></table>${button("Reserve your place", "#1e3a5f")}${paragraph("Have a question? Just reply to this email. We’ll be happy to help.")}`, "#1e3a5f", "A DATE FOR YOUR DIARY"),
    text: "Hi {{first_name}},\n\nYou’re invited to [event name].\n\nWhen: [Date, time and time zone]\nWhere: [Venue or online meeting]\n\nReserve your place: https://trezad.com\n\nQuestions? Reply to this email.",
  },
  {
    id: "personal", name: "A personal introduction", category: "Plain & personal", color: "#475569",
    description: "A simple letter for introductions and thoughtful follow-ups.",
    subject: "A quick introduction, {{first_name}}", preheader: "A personal note from the Trezad team.",
    html: `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>A personal note</title></head><body style="margin:0;padding:28px 20px;background-color:#ffffff;font-family:Arial,Helvetica,sans-serif;"><table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:580px;font-family:Arial,Helvetica,sans-serif;"><tr><td style="color:#334155;font-size:16px;line-height:1.9;">${paragraph("Hi {{first_name}},")}${paragraph("I wanted to introduce myself and share a little about what we do at Trezad.")}${paragraph("[Add a specific, relevant reason for reaching out. Explain how you can help in two or three clear sentences.]")}${paragraph("Would this be useful for you? I’d be happy to share a little more, or answer any questions.")}${paragraph("Best wishes,<br><strong style=\"color:#102134;\">[Your name]</strong><br>[Your role] · Trezad<br><a href=\"https://trezad.com\" style=\"color:#0969da;\">trezad.com</a>")}</td></tr></table></body></html>`,
    text: "Hi {{first_name}},\n\nI wanted to introduce myself and share a little about what we do at Trezad.\n\n[Add a specific, relevant reason for reaching out.]\n\nWould this be useful for you? I’d be happy to share more.\n\nBest wishes,\n[Your name]\n[Your role] · Trezad\nhttps://trezad.com",
  },
];

export const BLANK_EMAIL_HTML = frame(`${paragraph("Hi {{first_name}},")}${paragraph("Start writing your message here.")}${button("Find out more")}${paragraph("Best wishes,<br>The Trezad team")}`);
