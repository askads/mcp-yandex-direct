import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TokenStore } from "../auth.js";
import type { YandexDirectClient } from "../client.js";
import {
  clearPendingLogin,
  exchangeCode,
  oauthClientId,
  pendingLogin,
  startLogin,
} from "../oauth.js";
import { fail, ok, READ_ONLY, WRITE_DELETE, WRITE_UPDATE } from "./util.js";

/**
 * The in-chat login. Two steps because the user has to leave for the browser in
 * between: `start_login` hands out a URL, `finish_login` redeems the code they
 * bring back. The PKCE verifier never leaves this process, so the code passing
 * through the chat is useless to anyone who reads it — and it dies in 10 minutes.
 */
export function registerAuthTools(
  server: McpServer,
  client: YandexDirectClient,
  tokens: TokenStore,
): void {
  server.registerTool(
    "auth_status",
    {
      title: "Статус подключения к Директу",
      annotations: READ_ONLY,
      description:
        "Показывает, подключён ли Яндекс Директ: есть ли токен, откуда он взят (переменная окружения YANDEX_DIRECT_TOKEN или сохранённый вход), когда истекает и где лежит файл с сохранёнными данными. Ничего не отправляет в сеть и не показывает сам токен. Вызовите это, если инструменты Директа отвечают, что подключение не настроено.",
      inputSchema: {},
    },
    async () => {
      try {
        return ok(tokens.status());
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "start_login",
    {
      title: "Начать подключение Директа",
      annotations: READ_ONLY,
      description:
        "Первый шаг подключения Яндекс Директа без правки конфигурации и без перезапуска клиента. Возвращает ссылку на страницу Яндекс OAuth. Покажите ссылку пользователю целиком и попросите: открыть её в браузере под аккаунтом, у которого есть доступ к нужному рекламному кабинету, подтвердить доступ и прислать показанный код подтверждения. Полученный код передайте в finish_login. Код действует 10 минут. Сам по себе код бесполезен для постороннего: обменять его может только этот сервер.",
      inputSchema: {},
    },
    async () => {
      try {
        const { authorizeUrl } = startLogin();
        return ok({
          authorizeUrl,
          clientId: oauthClientId(),
          expiresInMinutes: 10,
          nextStep:
            "Покажите пользователю ссылку authorizeUrl, дождитесь кода подтверждения и вызовите finish_login с этим кодом.",
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "finish_login",
    {
      title: "Завершить подключение Директа",
      annotations: WRITE_UPDATE,
      description:
        "Второй шаг подключения: обменивает код подтверждения из start_login на токен доступа, сохраняет его в файл только для владельца (0600) и сразу проверяет живым запросом к Директу. После успеха остальные инструменты работают немедленно — перезапускать клиент не нужно. Код одноразовый и живёт 10 минут: если он не принят, вызовите start_login заново и попросите свежий.",
      inputSchema: {
        code: z
          .string()
          .min(1)
          .describe("Код подтверждения, который Яндекс показал пользователю после входа."),
      },
    },
    async ({ code }) => {
      try {
        const pending = pendingLogin();
        if (!pending) {
          return fail(
            "Нет активного запроса на подключение (или он истёк — он живёт 10 минут). " +
              "Вызовите start_login и повторите вход.",
          );
        }

        const response = await exchangeCode({
          code: code.trim(),
          verifier: pending.verifier,
          clientId: pending.clientId,
        });
        tokens.save(response);
        clearPendingLogin();

        // Prove it works before telling the user it does: clients/get authenticates
        // against the real cabinet (and honors Client-Login for agencies), so a
        // wrong-account login surfaces here instead of as a bare error one call later.
        const account = await client.call<{ Clients?: Array<{ Login?: string }> }>(
          "clients",
          "get",
          { FieldNames: ["Login", "ClientId"] },
        );
        const login = account.Clients?.[0]?.Login;

        return ok({
          connected: true,
          accountLogin: login,
          storedAt: tokens.status().path,
          // Present only when Yandex granted less than SCOPE asked for — worth
          // surfacing, because the failure it causes shows up later as a bare 53.
          grantedScope: response.scope,
          note:
            "Подключение готово, инструменты Директа можно вызывать сразу. " +
            "Покажите пользователю логин аккаунта: если это не тот кабинет, повторите start_login под нужным аккаунтом.",
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "logout",
    {
      title: "Отключить Директ",
      annotations: WRITE_DELETE,
      description:
        "Удаляет сохранённый токен Директа с диска. Токен, заданный переменной окружения YANDEX_DIRECT_TOKEN, не трогает — его нужно убирать из конфигурации клиента вручную. Доступ, выданный приложению, остаётся активным на стороне Яндекса: отозвать его можно в Яндекс ID.",
      inputSchema: {},
    },
    async () => {
      try {
        const removed = tokens.logout();
        clearPendingLogin();
        return ok({
          removed,
          note: removed
            ? "Сохранённый токен удалён."
            : "Сохранённого токена не было — удалять нечего.",
          envTokenStillSet: tokens.status().source === "env",
        });
      } catch (e) {
        return fail(e);
      }
    },
  );
}
