import { useEffect, useState } from 'react';
import { useForm, type Path } from 'react-hook-form';
import { useTranslation } from '../i18n/I18nProvider';
import type { EventPrize } from '@shared/types';
import { Spinner } from './Spinner';
import { ErrorBanner } from './ErrorBanner';

export interface PrizeFormValues {
  name: string;
  description: string;
  imageUrl: string;
  quantity: string;
}

export interface PrizeFormSubmit {
  name: string;
  description: string | null;
  imageUrl: string | null;
  quantity: number;
}

/** Only http/https may become an `src`; anything else is refused up front. */
function isDisplayableUrl(value: string): boolean {
  if (value.trim().length === 0) return true;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function PrizeForm({
  prize,
  editableFields,
  submitting,
  errorMessage,
  fieldErrors,
  onSubmit,
  onCancel,
}: {
  prize?: EventPrize;
  /** Fields the event's state permits. Everything else renders read-only. */
  editableFields?: readonly string[];
  submitting: boolean;
  errorMessage?: string | null;
  fieldErrors?: Record<string, string>;
  onSubmit: (values: PrizeFormSubmit) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const isEdit = Boolean(prize);

  const {
    register,
    handleSubmit,
    watch,
    setError,
    formState: { errors },
  } = useForm<PrizeFormValues>({
    mode: 'onTouched',
    defaultValues: {
      name: prize?.name ?? '',
      description: prize?.description ?? '',
      imageUrl: prize?.imageUrl ?? '',
      quantity: String(prize?.quantity ?? 1),
    },
  });

  const imageUrl = watch('imageUrl');
  const [imageBroken, setImageBroken] = useState(false);

  useEffect(() => setImageBroken(false), [imageUrl]);

  // Server-side field errors surface on the matching input.
  useEffect(() => {
    if (!fieldErrors) return;
    for (const [field, message] of Object.entries(fieldErrors)) {
      setError(field as Path<PrizeFormValues>, { message });
    }
  }, [fieldErrors, setError]);

  const canEdit = (field: keyof PrizeFormValues) =>
    editableFields ? editableFields.includes(field) : true;

  function submit(values: PrizeFormValues) {
    const trimmed = (raw: string) => {
      const value = raw.trim();
      return value.length === 0 ? null : value;
    };
    onSubmit({
      name: values.name.trim(),
      description: trimmed(values.description),
      imageUrl: trimmed(values.imageUrl),
      quantity: Number(values.quantity || '1'),
    });
  }

  const preview = isDisplayableUrl(imageUrl) ? imageUrl.trim() : '';

  return (
    <form className="space-y-4" onSubmit={handleSubmit(submit)} noValidate>
      {errorMessage && <ErrorBanner message={errorMessage} />}

      <div>
        <label className="label" htmlFor="prize-name">
          {t('prize.field.name')}
        </label>
        <input
          id="prize-name"
          className="input h-11 rounded-lg"
          aria-invalid={errors.name ? 'true' : undefined}
          aria-describedby={errors.name ? 'prize-name-error' : undefined}
          disabled={!canEdit('name')}
          {...register('name', {
            required: t('prize.error.nameRequired'),
            maxLength: { value: 120, message: t('prize.error.nameTooLong') },
          })}
        />
        {errors.name && (
          <p id="prize-name-error" role="alert" className="mt-1 text-xs text-red-600">
            {errors.name.message}
          </p>
        )}
      </div>

      <div>
        <label className="label" htmlFor="prize-quantity">
          {t('prize.field.quantity')}
        </label>
        <input
          id="prize-quantity"
          type="number"
          min={1}
          max={1000}
          className="input h-11 rounded-lg"
          aria-invalid={errors.quantity ? 'true' : undefined}
          aria-describedby={errors.quantity ? 'prize-quantity-error' : undefined}
          disabled={!canEdit('quantity')}
          {...register('quantity', {
            required: t('prize.error.quantityRequired'),
            min: { value: 1, message: t('prize.error.quantityRange') },
            max: { value: 1000, message: t('prize.error.quantityRange') },
          })}
        />
        {!canEdit('quantity') && (
          <p className="mt-1 text-xs text-slate-500">{t('prize.hint.quantityFrozen')}</p>
        )}
        {errors.quantity && (
          <p id="prize-quantity-error" role="alert" className="mt-1 text-xs text-red-600">
            {errors.quantity.message}
          </p>
        )}
      </div>

      <div>
        <label className="label" htmlFor="prize-description">
          {t('prize.field.description')}
        </label>
        <textarea
          id="prize-description"
          rows={3}
          className="input rounded-lg"
          disabled={!canEdit('description')}
          {...register('description', {
            maxLength: { value: 2000, message: t('prize.error.descriptionTooLong') },
          })}
        />
        {errors.description && (
          <p role="alert" className="mt-1 text-xs text-red-600">
            {errors.description.message}
          </p>
        )}
      </div>

      <div>
        <label className="label" htmlFor="prize-image">
          {t('prize.field.imageUrl')}
        </label>
        <input
          id="prize-image"
          type="url"
          inputMode="url"
          className="input h-11 rounded-lg"
          placeholder="https://..."
          aria-invalid={errors.imageUrl ? 'true' : undefined}
          disabled={!canEdit('imageUrl')}
          {...register('imageUrl', {
            validate: (value) => isDisplayableUrl(value) || t('prize.error.imageUrl'),
          })}
        />
        {errors.imageUrl ? (
          <p role="alert" className="mt-1 text-xs text-red-600">
            {errors.imageUrl.message}
          </p>
        ) : (
          <p className="mt-1 text-xs text-slate-500">{t('prize.hint.imageUrl')}</p>
        )}

        {preview.length > 0 && (
          <div className="mt-2">
            {imageBroken ? (
              <p className="text-xs text-amber-700">{t('prize.image.broken')}</p>
            ) : (
              <img
                src={preview}
                alt=""
                className="h-20 w-20 rounded-lg border border-slate-900/10 object-cover"
                onError={() => setImageBroken(true)}
              />
            )}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2 pt-2 sm:flex-row-reverse">
        <button type="submit" className="btn-primary text-xs sm:w-auto" disabled={submitting}>
          {submitting ? (
            <>
              <Spinner /> {t('prize.action.saving')}
            </>
          ) : isEdit ? (
            t('prize.action.save')
          ) : (
            t('prize.action.create')
          )}
        </button>
        <button type="button" className="btn-secondary text-xs sm:w-auto" onClick={onCancel}>
          {t('prize.action.cancel')}
        </button>
      </div>
    </form>
  );
}
