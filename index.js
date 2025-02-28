const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const { OpenAI } = require("openai");
const supabase = require("./supabaseClient");
require("dotenv").config();
const app = express();
const port = process.env.PORT || 8000;

const openai = new OpenAI({
apiKey:
process.env.OPENAI_API_KEY,
});

const client = new twilio(process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN);
  app.use(bodyParser.urlencoded({ extended: false }));
  app.use(bodyParser.json());
  let allData = []
  let userSessions = {};

async function getAllTasks() {
  const { data, error } = await supabase.from("tasks").select("*");
  if (error) throw error;
  console.log('data==>',data);
  return data;
  }
  
  async function main() {
  allData = await getAllTasks();
  console.log('allData==>',allData);
  }

  main();
  
  app.get("/refresh", async (req, res) => {
  console.log("Refreshing tasks from Supabase...");
  const { data, error } = await supabase.from("tasks").select("*");
  if (error) {
  console.error("Error refreshing tasks:", error);
  return res.status(500).json({ message: "Error fetching tasks" });
  }
  allData = data;
  console.log("Tasks updated!");
  res.status(200).json({ message: "Tasks refreshed successfully", tasks:
  allData });
  });  

async function handleUserInput(userMessage, From) {
console.log('we are here===> 1');
const session = userSessions[From];
const conversationHistory = session.conversationHistory || [];
conversationHistory.push({ role: "user", content: userMessage });
console.log('we are here===> 2');
const prompt = `
You are a helpful task manager assistant. Respond with a formal tone and a step-by-step format.
Your goal is to guide the user through task assignment:
- Ask for task details (task, assignee, due date, time).
- Respond to yes/no inputs appropriately.
- Follow up if any information is incomplete.
- Keep the respone concise and structured.

IMPORTANT: 
    - Once all details are collected, respond **ONLY** with a JSON object.
    - Do **not** include any extra text before or after the JSON.
    - This is only for backend procesing so do **NOT** send this JSON format to user
    - The JSON format should be:

    {
      "task": "<task_name>",
      "assignee": "<assignee_name>",
      "dueDate": "<YYYY-MM-DD>",
      "dueTime": "<HH:mm>",
    }

After having all the details you can send the summary of the response so that user can have a look at it.
For due dates:
- If the user provides a day and month (e.g., "28th Feb" or "28 February"), convert it into the current year (e.g., "2025-02-28").
- If the user provides a full date (e.g., "28th Feb 2025"), return it as is.
- If no year is provided, assume the current year which is 2025 and return the date in the format YYYY-MM-DD.

For due times:
- If the user provides a time in "AM/PM" format (e.g., "6 PM" or "6 AM"), convert it into the 24-hour format:
  - "6 AM" becomes "06:00"
  - "6 PM" becomes "18:00"
- Ensure the output time is always in the 24-hour format (HH:mm).

Conversation history: ${JSON.stringify(conversationHistory)}
User input: ${userMessage}
`;
console.log('we are here===> 3');

try {
const response = await openai.chat.completions.create({
model: "gpt-3.5-turbo",
messages: [{ role: "system", content: prompt }],
});

console.log('we are here===> 4');
const botReply = response.choices[0].message.content;
session.conversationHistory = conversationHistory;
console.log('we are here===> 5', botReply);

sendMessage(From, botReply);

try {
  const taskData = JSON.parse(botReply);
  const assignedPerson = allData.find((person) => person.name.toLowerCase() === taskData.assignee.toLowerCase());

  console.log('assignedPerson--->',assignedPerson);
  console.log('allData--->',allData);
  console.log("taskData" ,taskData);

  if(assignedPerson){
    let dueDateTime = `${taskData.dueDate} ${taskData.dueTime}`;
    if (taskData.task && taskData.assignee && taskData.dueDate && taskData.dueTime) {
      const { data, error } = await supabase.from("tasks").update([{
          tasks: taskData.task,
          reminder: false,
          task_done: 'Pending',
          due_date: dueDateTime
      }])
      .eq('name', taskData.assignee)
      .single()

      console.log("Matching Task:", data, error);

      if (error) {
          console.error("Error inserting task into Supabase:", error);
      } else {
          console.log("Task successfully added to Supabase.");
          sendMessage(From, `Task assigned to ${taskData.assignee}:"${taskData.task}" with a due date of ${dueDateTime}`);
          sendMessage(`whatsapp:+${assignedPerson.phone}`,`Hello ${taskData.assignee}, a new task has been assigned to you:"${taskData.task}".\n\nDeadline: ${dueDateTime}`);
          delete userSessions[From];
          session.conversationHistory = [];
      }
  }
  }
  else {
    sendMessage(From, "Error: Could not find assignee.");
    }

} catch (parseError) {
  console.error("Error parsing task details:", parseError);
}

} catch (error) {
console.error("Error processing user input with ChatGPT:", error);
sendMessage(From, "Sorry, I couldn't process your message right now. Please try again.");
}
}

function sendMessage(to, message) {
console.log("Sending message to:", to);
console.log("Message:", message);
client.messages
.create({
from: process.env.TWILIO_PHONE_NUMBER,
to,
body: message,
})
.then((message) => {
console.log("Message sent successfully:", message.sid);
})
.catch((err) => {
console.error("Error sending message:", err);
if (err.code) {
console.error("Twilio error code:", err.code);
}
});
}
async function makeTwilioRequest() {
app.post("/whatsapp", async (req, res) => {
const { Body, From } = req.body;
const userMessage = Body.trim();
if (!userSessions[From]) {
userSessions[From] = {
step: 0,
task: "",
assignee: "",
dueDate: "",
dueTime: "",
assignerNumber: From,
conversationHistory: []
};
}
console.log(userMessage, From);
await handleUserInput(userMessage, From);
res.end();
});
}

app.listen(port, () => {
console.log(`Server running on port ${port}`);
makeTwilioRequest();
});