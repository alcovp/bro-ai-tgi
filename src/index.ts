import { Telegraf, Context } from 'telegraf'
import { message } from 'telegraf/filters'
import dotenv from 'dotenv'
import axios from 'axios'
import { Message } from 'telegraf/typings/core/types/typegram'

// Загружаем переменные окружения
dotenv.config()

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID
const MAX_CONTEXT = parseInt(process.env.MAX_CONTEXT_MESSAGES || '10', 10)
const BACKEND_URL = process.env.BACKEND_API_URL // Пока не используется

if (!BOT_TOKEN) {
    throw new Error('"TELEGRAM_BOT_TOKEN" environment variable is required!')
}
if (!ADMIN_ID) {
    console.warn('"ADMIN_TELEGRAM_ID" environment variable is recommended for admin features.')
}
if (!BACKEND_URL) {
    throw new Error('"BACKEND_API_URL" environment variable is required!')
}

interface MessageInfo {
    id: number
    text: string
    sender: string // Имя пользователя или ID
    timestamp: number
}

// Простой кэш для хранения контекста последних сообщений для каждого чата
// Ключ - chat ID, значение - массив сообщений
const chatContextCache = new Map<number, MessageInfo[]>()

// Инициализация бота
const bot = new Telegraf(BOT_TOKEN)

// --- Переменная для хранения информации о боте ---
let botUsername = 'Bot'
bot.telegram
    .getMe()
    .then((me) => {
        botUsername = me.username || `Bot_${me.id}`
        console.log(`Bot info fetched: Username=${botUsername}, ID=${me.id}`)
    })
    .catch((err) => {
        console.error('Failed to get bot info:', err)
    })
// --- Конец блока получения информации о боте ---

// --- Middleware ---
// Логирование всех входящих обновлений (полезно для отладки)
bot.use(async (ctx, next) => {
    const start = Date.now()
    await next() // Передаем управление следующему обработчику
    const ms = Date.now() - start
    console.log('Response time: %sms', ms)
    // console.log('Update:', JSON.stringify(ctx.update, null, 2)); // Раскомментируйте для детального лога
})

// --- Обработчики команд ---
bot.start((ctx) => {
    if (String(ctx.message.from.id) === ADMIN_ID) {
        ctx.reply(
            'Привет! Я бот-участник этого чата. Добавьте меня в группу, и я постараюсь быть интересным собеседником.\nНе забудьте отключить режим приватности для меня в настройках группы или через @BotFather, чтобы я мог видеть все сообщения.'
        )
    }
})

// Пример команды только для админа
bot.command('admincheck', (ctx) => {
    if (String(ctx.message.from.id) === ADMIN_ID) {
        ctx.reply(`Привет, Админ! Ваш ID: ${ctx.message.from.id}`)
    } else {
        ctx.reply('Эта команда доступна только администратору бота.')
        console.log(`Attempted admin command access by user ID: ${ctx.message.from.id}`)
    }
})

// --- Обработчик текстовых сообщений ---
bot.on(message('text'), async (ctx) => {
    const chatId = ctx.chat.id
    const messageText = ctx.message.text
    const userId = ctx.message.from.id
    const username = ctx.message.from.username || ctx.message.from.first_name || `User_${userId}`
    const messageId = ctx.message.message_id
    const timestamp = ctx.message.date

    console.log(
        `[Chat ${chatId}] Received message from ${username} (ID: ${userId}): "${messageText}"`
    )

    // 1. Обновляем контекст чата
    if (!chatContextCache.has(chatId)) {
        chatContextCache.set(chatId, [])
    }
    const currentContext = chatContextCache.get(chatId)! // ! - т.к. мы только что проверили и установили

    const newMessageInfo: MessageInfo = {
        id: messageId,
        text: messageText,
        sender: username,
        timestamp: timestamp,
    }
    currentContext.push(newMessageInfo)

    // Ограничиваем размер контекста
    while (currentContext.length > MAX_CONTEXT) {
        currentContext.shift() // Удаляем самое старое сообщение
    }
    console.log(`[Chat ${chatId}] Context size after user message: ${currentContext.length}`)

    const dataToSend = {
        chat_id: chatId,
        new_message: newMessageInfo,
        history: [...currentContext],
    }

    console.log(`[Chat ${chatId}] Calling backend API at ${BACKEND_URL}...`)
    let botResponseText: string | null = null

    try {
        const response = await axios.post<{ response_text: string | null }>(
            BACKEND_URL,
            dataToSend,
            { timeout: 30000 } // Таймаут 30 секунд (OpenAI может отвечать долго)
        )

        console.log(`[Chat ${chatId}] Backend responded with status: ${response.status}`)
        if (response.data && response.data.response_text) {
            botResponseText = response.data.response_text
            console.log(`[Chat ${chatId}] AI response received: "${botResponseText}"`)
        } else {
            console.log(`[Chat ${chatId}] AI decided not to reply.`)
        }
    } catch (error) {
        if (axios.isAxiosError(error)) {
            console.error(`[Chat ${chatId}] Axios error calling backend: ${error.message}`)
            if (error.response) {
                console.error(`[Chat ${chatId}] Backend error status: ${error.response.status}`)
                console.error(`[Chat ${chatId}] Backend error data:`, error.response.data)
            } else if (error.request) {
                console.error(`[Chat ${chatId}] No response received from backend.`)
            }
        } else {
            console.error(`[Chat ${chatId}] Non-axios error calling backend:`, error)
        }
        // Можно добавить логику повторных попыток или уведомление админа
        // В данном случае просто не будем отвечать, если бэкенд недоступен/ошибся
    }
    // --- КОНЕЦ ВЫЗОВА БЭКЕНДА ---

    if (botResponseText) {
        try {
            // Отправляем ответ и получаем объект отправленного сообщения
            const sentMessage: Message.TextMessage = await ctx.reply(botResponseText)
            console.log(`[Chat ${chatId}] Sent reply, message ID: ${sentMessage.message_id}`)

            // Создаем информацию об ответе БОТА
            const botMessageInfo: MessageInfo = {
                id: sentMessage.message_id, // ID сообщения, которое отправил бот
                text: botResponseText, // Текст ответа бота
                sender: botUsername, // Имя бота (получено при запуске)
                timestamp: sentMessage.date, // Время отправки сообщения ботом
            }

            // Добавляем ответ БОТА в контекст
            currentContext.push(botMessageInfo)
            console.log(`[Chat ${chatId}] Added bot reply to context.`)

            // Снова ограничиваем размер контекста ПОСЛЕ добавления ответа бота
            while (currentContext.length > MAX_CONTEXT) {
                currentContext.shift() // Удаляем самое старое сообщение (может быть как пользователя, так и бота)
            }
            console.log(`[Chat ${chatId}] Context size after bot reply: ${currentContext.length}`)
            // console.log(`[Chat ${chatId}] Updated Context:`, currentContext) // Раскомментируйте для отладки содержимого контекста
        } catch (error) {
            console.error(`[Chat ${chatId}] Error sending reply or updating context:`, error)
        }
    } else {
        console.log(`[Chat ${chatId}] No reply sent, context not updated with bot message.`)
    }
})

// --- Обработка ошибок ---
bot.catch((err, ctx) => {
    console.error(`Error for ${ctx.updateType}`, err)
    // Можно добавить отправку сообщения об ошибке администратору
    // if (ADMIN_ID) {
    //   ctx.telegram.sendMessage(ADMIN_ID, `Произошла ошибка в боте: ${err}`);
    // }
})

// --- Запуск бота ---
bot.launch()
    .then(() => {
        console.log('Bot started successfully!')
    })
    .catch((error) => {
        console.error('Failed to start bot:', error)
    })

// Обеспечиваем корректную остановку бота
process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))

console.log('Bot script finished execution setup. Starting...')
