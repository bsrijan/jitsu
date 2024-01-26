import Stripe from "stripe";
import { store } from "./services";
import { assertDefined, assertTrue, getLog, requireDefined } from "juava";
import { omit } from "lodash";

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
  apiVersion: "2022-11-15",
  appInfo: {
    name: "Jitsu Cloud v2 Billing service",
    version: "0.2.0",
  },
});

export const stripeDataTable =
  (process.env.STRIPE_SECRET_KEY as string)?.indexOf("_live_") >= 0 ? "stripe-settings" : "stripe-settings-test-mode";

export type SubscriptionStatus = {
  planId: string;
  expiresAt?: string;
  renewAfterExpiration?: boolean;
} & Record<string, any>;

export type Day = `${number}${number}${number}${number}-${number}${number}-${number}${number}`;

//entry of `stripe-settings` / `stripe-settings-test-mode` table
export type StripeDataTableEntry = {
  //always present even if billing is not managed through stripe
  stripeCustomerId: string;
  //if true - no restrictions on workspace, essentially "give everything for free
  noRestrictions?: boolean;
  //custom settings of the plan. Overwrites ones coming from Stripe plan
  customSettings?: Record<string, any>;
  //if set, billing settings will be taken from this object, not from Stripe. Plan settings should be
  //present in `customSettings` field
  customBilling?: {
    start: Day;
    end?: Day;
  };
};

export async function getOrCreateCurrentSubscription(
  workspaceId: string,
  userEmail: () => string,
  opts: { changeEmail?: boolean } = {}
): Promise<{
  stripeCustomerId: string;
  customBilling?: boolean;
  noRestrictions?: boolean;
  subscriptionStatus: SubscriptionStatus;
}> {
  let stripeOptions: StripeDataTableEntry = await store.getTable(stripeDataTable).get(workspaceId);
  if (!stripeOptions) {
    const email = userEmail();
    const existingCustomers = await stripe.customers.list({ email });
    getLog()
      .atInfo()
      .log(
        `${workspaceId} doesn't have a linked stripe customer. Found ${existingCustomers.data.length} customers with email ${email}`
      );
    const newCustomer =
      existingCustomers.data.length > 0 ? existingCustomers.data[0] : await stripe.customers.create({ email });
    await store.getTable(stripeDataTable).put(workspaceId, { stripeCustomerId: newCustomer.id });
    stripeOptions = { stripeCustomerId: newCustomer.id };
  }
  if (opts.changeEmail) {
    await stripe.customers.update(stripeOptions.stripeCustomerId, { email: userEmail() });
  }

  if (stripeOptions.customBilling) {
    //in UTC, at 00:00:00
    getLog()
      .atDebug()
      .log(
        `Custom billing is set for workspace ${workspaceId}: ${JSON.stringify(stripeOptions.customBilling, null, 2)}`
      );

    const startDate = new Date(stripeOptions.customBilling.start + "T00:00:00Z");
    getLog().atInfo().log(`Subscription start date for workspace ${workspaceId}: ${startDate.toISOString()}`);
    if (startDate.getTime() > new Date().getTime()) {
      getLog()
        .atInfo()
        .log(`Subscription start date for workspace ${workspaceId}: ${startDate.toISOString()} - future`);
      return {
        stripeCustomerId: stripeOptions.stripeCustomerId,
        subscriptionStatus: {
          //customBilling: true,
          planId: "free",
          futureSubscriptionDate: startDate,
        },
      };
    }
    const startDay = startDate.getUTCDate();
    const currentDay = new Date().getUTCDate();
    const expiresAt = new Date();
    expiresAt.setUTCDate(startDay);
    if (currentDay > startDay) {
      expiresAt.setUTCMonth(expiresAt.getUTCMonth() + 1);
    }

    return {
      stripeCustomerId: stripeOptions.stripeCustomerId,
      subscriptionStatus: {
        customBilling: true,
        planId: "$custom",
        expiresAt: expiresAt.toISOString(),
        renewAfterExpiration: true,
        ...stripeOptions.customSettings,
      },
    };
  }

  const plan = (await getActivePlan(stripeOptions.stripeCustomerId)) || { planId: "free" };
  return {
    stripeCustomerId: stripeOptions.stripeCustomerId,
    noRestrictions: !!stripeOptions.noRestrictions,
    subscriptionStatus: {
      ...plan,
      ...(stripeOptions.customSettings || {}),
    },
  };
}

export function stripeLink(entity: string, id: string) {
  return `https://dashboard.stripe.com/${entity}/${id}`;
}

export async function getActivePlan(customerId: string): Promise<null | SubscriptionStatus> {
  const subscriptions = await stripe.subscriptions.list({ customer: customerId, status: "all", limit: 10 });
  const sub2product = new Map<string, Stripe.Product>();
  for (const sub of subscriptions.data) {
    const productId = sub.items.data[0].price.product;
    assertDefined(productId, `Can't get product from subscription ${sub.id}`);
    assertTrue(typeof productId === "string", `Subscription ${sub.id} should have a string product id`);
    const product = await stripe.products.retrieve(productId as string);
    assertDefined(product, `Can't get product ${productId} from subscription ${sub.id}. Product doesn't exist`);
    sub2product.set(sub.id, product);
  }
  //first, look for active non-legacy plans
  const activeSubscription = subscriptions.data.find(sub => {
    const product = requireDefined(sub2product.get(sub.id), `Can't find product for subscription ${sub.id}`);
    return sub.status === "active" && product.metadata?.object_tag === getStripeObjectTag();
  });
  const pastDueSubscription = subscriptions.data.find(sub => {
    const product = requireDefined(sub2product.get(sub.id), `Can't find product for subscription ${sub.id}`);
    return sub.status === "past_due" && product.metadata?.object_tag === getStripeObjectTag();
  });
  const subscription = activeSubscription || pastDueSubscription;
  if (subscription) {
    const product = requireDefined(
      sub2product.get(subscription.id),
      `Can't find product for subscription ${subscription.id}`
    );
    return {
      planId: requireDefined(product.metadata?.jitsu_plan_id),
      planName: product.name,
      expiresAt: new Date(subscription.current_period_end * 1000).toISOString(),
      renewAfterExpiration: !subscription.cancel_at_period_end,
      pastDue: pastDueSubscription && !activeSubscription,
      //omit token field that might be considered as sensitive
      ...omit(
        JSON.parse(requireDefined(product.metadata?.plan_data, `Can't find plan data for product ${product.id}`)),
        "token"
      ),
      subscriptionId: subscription.id,
    };
  }
  //second, look for just cancelled non-legacy plans
  const pastDue = subscriptions.data.find(sub => {
    const product = requireDefined(sub2product.get(sub.id), `Can't find product for subscription ${sub.id}`);
    if (
      sub.status === "past_due" &&
      product.metadata?.object_tag === getStripeObjectTag() &&
      sub.cancel_at_period_end
    ) {
      return product;
    }
  });
  //todo - look for legacy plans
  return null;
}

export function getStripeObjectTag() {
  return (process.env.STRIPE_OBJECT_TAG as string) || "jitsu2.0";
}

/**
 * opts.custom - if custom priced products should be included
 * @param opts
 */
export async function getAvailableProducts(opts: { custom?: boolean } = {}) {
  const stripeObjectTag = getStripeObjectTag();
  const products = (await stripe.products.list({ limit: 100 })).data
    .filter(p => p.metadata?.object_tag === stripeObjectTag)
    .filter(p => {
      if (opts.custom) {
        //include everything
        return true;
      } else {
        //check if product is custom priced
        const meta = p.metadata?.plan_data ? JSON.parse(p.metadata?.plan_data) : undefined;
        return !meta?.custom;
      }
    });
  if (products.length === 0) {
    throw new Error(`No products with tag ${stripeObjectTag} found`);
  }
  return products;
}

export async function getOrCreatePortalConfiguration() {
  const configurations = await stripe.billingPortal.configurations.list({ limit: 10 });
  const stripeObjectTag = getStripeObjectTag();
  const configuration = configurations.data.find(
    configuration => configuration.metadata?.object_tag === stripeObjectTag
  );
  const products = await getAvailableProducts();
  const allowedProducts = products.map(p => ({ product: p.id, prices: [p.default_price] }));
  const customerPortalConfig = {
    business_profile: {
      headline: "Jitsu.Cloud",
      privacy_policy_url: "https://jitsu.com/privacy",
      terms_of_service_url: "https://jitsu.com/tos",
    },
    features: {
      subscription_pause: {
        enabled: false,
      },
      subscription_cancel: {
        enabled: true,
        cancellation_reason: {
          enabled: true,
          options: [
            "customer_service",
            "low_quality",
            "missing_features",
            "other",
            "switched_service",
            "too_complex",
            "too_expensive",
            "unused",
          ],
        },
      },
      customer_update: {
        enabled: true,
        allowed_updates: ["address", "email", "name", "phone"],
      },
      //billing_address_collection: "required",
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_update: {
        default_allowed_updates: ["price"],
        enabled: true,
        products: allowedProducts,
        proration_behavior: "always_invoice",
      },
    },

    metadata: {
      customer_portal_tag: stripeObjectTag,
    },
  };
  let configurationId = configuration?.id;
  if (!configuration) {
    configurationId = (await stripe.billingPortal.configurations.create(customerPortalConfig as any)).id;
  } else {
    await stripe.billingPortal.configurations.update(configuration.id, customerPortalConfig as any);
  }
  return configurationId;
}

export async function listAllInvoices() {
  const timer = Date.now();
  let starting_after: string | undefined = undefined;
  const allInvoices: Stripe.Invoice[] = [];
  do {
    const result = await stripe.invoices.list({
      limit: 100,
      status: "paid",
      starting_after: starting_after,
      created: {
        //invoices for past 90 days
        gte: Math.floor(Date.now() / 1000 - 90 * 24 * 60 * 60),
      },
    });
    starting_after = result?.data[result.data.length - 1]?.id;
    if (result?.data) {
      allInvoices.push(...result?.data);
    }
  } while (starting_after);
  getLog()
    .atInfo()
    .log(`${allInvoices.length} invoices found. Took ${Date.now() - timer}ms`);
  return allInvoices;
}

export function getInvoiceStartDate(invoice: Stripe.Invoice) {
  return new Date(invoice.lines.data[0].period.start * 1000);
}

export function getInvoiceEndDate(invoice: Stripe.Invoice) {
  return new Date(invoice.lines.data[0].period.end * 1000);
}

export async function listAllSubscriptions(): Promise<Stripe.Subscription[]> {
  let starting_after: string | undefined = undefined;
  const allSubscriptions: Stripe.Subscription[] = [];
  do {
    const result = await stripe.subscriptions.list({
      limit: 100,
      starting_after: starting_after,
    });
    starting_after = result?.data[result.data.length - 1]?.id;
    if (result?.data) {
      allSubscriptions.push(...result?.data);
    }
  } while (starting_after);
  return allSubscriptions;
}
